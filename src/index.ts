import { requireTenant } from "./access";
import { apiError, unauthorized } from "./api/respond";
import { handleApi, operationOf } from "./api/router";
import { isContentPath, serveContent } from "./content/route";
import type { Env } from "./env";
import { errorKindOf } from "./error-kind";
import { annotateLog, log, withLogContext } from "./log";
import {
  describeSyncMessage,
  handleDeadLetter,
  handleSyncMessage,
  parseSyncMessage,
  SYNC_DLQ,
} from "./sync/process";

export { TenantMail } from "./mail/tenant-mail";
export { TenantSearch } from "./search/tenant-search";
export { AccountSync } from "./sync/account-sync";

const CORRELATION_HEADER = "x-correlation-id";
const INBOUND_CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

const correlationIdOf = (request: Request): string => {
  const inbound = request.headers.get(CORRELATION_HEADER);
  if (inbound !== null && INBOUND_CORRELATION.test(inbound)) return inbound;
  return crypto.randomUUID();
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failed =
  (method: string, path: string) =>
  (error: unknown): Response => {
    const response = apiError(500, "InternalServerError", errorMessage(error));
    annotateLog({ errorKind: errorKindOf(error) });
    log.error("request failed", {
      event: "http.error",
      method,
      path,
      status: response.status,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return response;
  };

const authenticated = async (
  request: Request,
  env: Env,
  path: string,
  serve: typeof handleApi,
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
    return authenticated(request, env, url.pathname, handleApi);
  }
  if (isContentPath(url.pathname)) {
    return authenticated(request, env, url.pathname, serveContent);
  }
  return env.ASSETS.fetch(request);
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
    for (const message of batch.messages) {
      const body = parseSyncMessage(message.body);
      const correlationId =
        body === null || body.correlationId === "" ? message.id : body.correlationId;
      await withLogContext({ correlationId }, async () => {
        log.info("queue message", {
          queue: batch.queue,
          id: message.id,
          attempts: message.attempts,
          ...describeSyncMessage(body),
        });
        if (batch.queue === SYNC_DLQ) {
          await handleDeadLetter(env, body, message.attempts, message.body);
          message.ack();
          return;
        }
        if (body === null) throw new Error(`queue message ${message.id} is not a sync message`);
        await handleSyncMessage(env, body, message.attempts);
        message.ack();
      });
    }
  },
} satisfies ExportedHandler<Env, unknown>;
