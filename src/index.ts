import { api } from "@remit/backend/api";
import { identityOf, requireTenant, type Tenant } from "./access";
import { API_ROOT } from "./api/serve";
import { isContentPath, serveContent } from "./content/route";
import type { Env } from "./env";
import { errorKindOf, messageOf } from "./error-kind";
import { apiError, quotaExceeded, unauthorized } from "./http";
import {
  annotateLog,
  currentCorrelationId,
  installRemitLogger,
  log,
  logQueueConsume,
  logQueueDeadLetter,
  withLogContext,
} from "./log";
import {
  CONSUMED_QUEUES,
  type ConsumedQueue,
  FAMILY_OF,
  isConsumedQueue,
  parseEnvelope,
  SHARED_DLQ,
} from "./queue/routing";
import { tenantMail } from "./stubs";

export { TenantMail as TenantMailV2 } from "./mail/tenant-mail";

installRemitLogger();

const operations = api.init();

const CORRELATION_HEADER = "x-correlation-id";
const INBOUND_CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

const correlationIdOf = (request: Request): string => {
  const inbound = request.headers.get(CORRELATION_HEADER);
  if (inbound !== null && INBOUND_CORRELATION.test(inbound)) return inbound;
  return crypto.randomUUID();
};

class UnknownQueueError extends Error {
  readonly queue: string;

  constructor(queue: string) {
    super(`queue ${queue} has no consumer in this Worker`);
    this.name = "UnknownQueueError";
    this.queue = queue;
  }
}

const consumeEnveloped = async (
  env: Env,
  queue: ConsumedQueue,
  message: Message<unknown>,
): Promise<void> => {
  const family = CONSUMED_QUEUES[queue];
  const parsed = parseEnvelope(message.body);
  if (!parsed.ok) {
    message.retry();
    logQueueConsume({
      family,
      type: "Unreadable",
      attempt: message.attempts,
      durationMs: 0,
      outcome: "Retried",
      poolWaitMs: 0,
      errorKind: "validation",
      error: parsed.reason,
    });
    return;
  }
  const { envelope } = parsed;
  const fields = { family, type: envelope.event.type, attempt: message.attempts };
  await withLogContext(
    { correlationId: envelope.correlationId, tenantId: envelope.tenantId },
    () => {
      const started = Date.now();
      return tenantMail(env, envelope.tenantId)
        .consume(family, envelope, message.attempts)
        .then(
          (report) => {
            logQueueConsume({ ...fields, durationMs: Date.now() - started, ...report });
            if (report.outcome === "Acked") {
              message.ack();
              return;
            }
            message.retry();
          },
          (error: unknown) => {
            message.retry();
            logQueueConsume({
              ...fields,
              durationMs: Date.now() - started,
              outcome: "Unreachable",
              errorKind: errorKindOf(error),
              error: messageOf(error),
            });
          },
        );
    },
  );
};

const deadLetter = (message: Message<unknown>): void => {
  const parsed = parseEnvelope(message.body);
  const seen = { id: message.id, attempt: message.attempts };
  logQueueDeadLetter(
    parsed.ok
      ? {
          ...seen,
          family: FAMILY_OF[parsed.envelope.event.type],
          type: parsed.envelope.event.type,
          tenantId: parsed.envelope.tenantId,
          correlationId: parsed.envelope.correlationId,
        }
      : { ...seen, type: "Unreadable", reason: parsed.reason, body: message.body },
  );
  message.ack();
};

const failed =
  (method: string, path: string) =>
  (error: unknown): Response => {
    const kind = errorKindOf(error);
    const response =
      kind === "quota"
        ? quotaExceeded(messageOf(error))
        : apiError(500, "InternalServerError", messageOf(error));
    annotateLog({ errorKind: kind });
    log.error("request failed", {
      event: "http.error",
      method,
      path,
      status: response.status,
      error: messageOf(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return response;
  };

type Serve = (request: Request, env: Env, tenant: Tenant) => Promise<Response>;

const serveApi: Serve = (request, env, tenant) =>
  tenantMail(env, tenant.tenantId).api(request, identityOf(tenant), currentCorrelationId());

const authenticated = async (
  request: Request,
  env: Env,
  path: string,
  serve: Serve,
): Promise<Response> => {
  const result = await requireTenant(request, env);
  if (!result.ok) {
    log.warn("access denied", { path, reason: result.reason });
    return unauthorized(result.reason);
  }
  annotateLog({ tenantId: result.tenant.tenantId });
  return serve(request, env, result.tenant);
};

const route = (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname.startsWith("/api/")) {
    return authenticated(request, env, url.pathname, serveApi);
  }
  if (isContentPath(url.pathname)) {
    return authenticated(request, env, url.pathname, serveContent);
  }
  return env.ASSETS.fetch(request);
};

const operationOf = async (method: string, url: URL): Promise<string> => {
  await operations;
  const operation = api.matchOperation({
    method,
    path: url.pathname.slice(API_ROOT.length),
    headers: {},
  });
  return operation?.operationId ?? "unmatched";
};

const routeOf = (method: string, url: URL): Promise<string> => {
  if (url.pathname.startsWith("/api/")) return operationOf(method, url);
  if (isContentPath(url.pathname)) return Promise.resolve("content");
  return Promise.resolve("assets");
};

const statusClassOf = (status: number): string => `${Math.floor(status / 100)}xx`;

const tagged = (response: Response, correlationId: string): Response => {
  const copy = new Response(response.body, response);
  copy.headers.set(CORRELATION_HEADER, correlationId);
  return copy;
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const correlationId = correlationIdOf(request);
    return withLogContext({ correlationId }, async () => {
      const url = new URL(request.url);
      annotateLog({ route: await routeOf(request.method, url) });
      log.info("request", { method: request.method, path: url.pathname });
      const started = Date.now();
      const response = await Promise.resolve()
        .then(() => route(request, env, url))
        .catch(failed(request.method, url.pathname));
      log.info("response", {
        event: "http.response",
        method: request.method,
        path: url.pathname,
        status: response.status,
        statusClass: statusClassOf(response.status),
        durationMs: Date.now() - started,
      });
      return tagged(response, correlationId);
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { queue } = batch;
    if (isConsumedQueue(queue)) {
      for (const message of batch.messages) await consumeEnveloped(env, queue, message);
      return;
    }
    if (queue === SHARED_DLQ) {
      for (const message of batch.messages) deadLetter(message);
      return;
    }
    log.error("queue refused", { queue, size: batch.messages.length });
    throw new UnknownQueueError(queue);
  },
} satisfies ExportedHandler<Env, unknown>;
