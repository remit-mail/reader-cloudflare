import { api } from "@remit/backend/api";
import { identityOf, requireTenant, type Tenant } from "./access";
import { API_ROOT, CALENDAR_FEED_ROOT, MICROSOFT_OAUTH_CALLBACK } from "./api/paths";
import { isContentPath, serveContent } from "./content/route";
import { isUploadPath, serveUpload } from "./content/upload";
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
  calendarFeedTenant,
  feedNotFound,
  loggedPath,
  microsoftCallbackTenant,
  oauthRefused,
} from "./public-api";
import { FAMILY_OF, parseEnvelope, type QueueFamily, roleOfQueue } from "./queue/routing";
import { tickEveryTenant } from "./scheduler";
import { tenantMail } from "./stubs";

export { TenantMail as TenantMailV3 } from "./mail/tenant-mail";

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
  family: QueueFamily,
  message: Message<unknown>,
): Promise<void> => {
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

const servePublic = (request: Request, env: Env, tenantId: string): Promise<Response> => {
  annotateLog({ tenantId });
  return tenantMail(env, tenantId).publicApi(request, tenantId, currentCorrelationId());
};

const route = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname.startsWith(CALENDAR_FEED_ROOT)) {
    const tenantId = await calendarFeedTenant(env, url);
    if (tenantId === undefined) return feedNotFound();
    return servePublic(request, env, tenantId);
  }
  if (url.pathname === MICROSOFT_OAUTH_CALLBACK) {
    const callback = await microsoftCallbackTenant(env, url);
    if (!callback.ok) {
      log.warn("oauth callback refused", { oauthError: callback.oauthError });
      return oauthRefused(env, callback.oauthError);
    }
    return servePublic(request, env, callback.tenantId);
  }
  if (url.pathname.startsWith("/api/")) {
    return authenticated(request, env, url.pathname, serveApi);
  }
  if (isContentPath(url.pathname)) {
    return authenticated(request, env, url.pathname, serveContent);
  }
  if (isUploadPath(url.pathname)) {
    return authenticated(request, env, url.pathname, serveUpload);
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
  if (isUploadPath(url.pathname)) return Promise.resolve("upload");
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
      const path = loggedPath(url.pathname);
      annotateLog({ route: await routeOf(request.method, url) });
      log.info("request", { method: request.method, path });
      const started = Date.now();
      const response = await Promise.resolve()
        .then(() => route(request, env, url))
        .catch(failed(request.method, path));
      log.info("response", {
        event: "http.response",
        method: request.method,
        path,
        status: response.status,
        statusClass: statusClassOf(response.status),
        durationMs: Date.now() - started,
      });
      return tagged(response, correlationId);
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { queue } = batch;
    const role = roleOfQueue(queue);
    if (role.kind === "consumed") {
      for (const message of batch.messages) await consumeEnveloped(env, role.family, message);
      return;
    }
    if (role.kind === "deadLetter") {
      for (const message of batch.messages) deadLetter(message);
      return;
    }
    log.error("queue refused", { queue, size: batch.messages.length });
    throw new UnknownQueueError(queue);
  },

  scheduled(controller: ScheduledController, env: Env): Promise<void> {
    return tickEveryTenant(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env, unknown>;
