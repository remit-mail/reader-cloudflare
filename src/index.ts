import { requireTenant } from "./access";
import { apiError, unauthorized } from "./api/respond";
import { handleApi } from "./api/router";
import { commit } from "./commit";
import { isContentPath, serveContent } from "./content/route";
import type { Env, SyncMessage } from "./env";
import { log, withLogContext } from "./log";
import { describeSyncMessage, processSyncMessage } from "./sync/process";

export { TenantMail } from "./mail/tenant-mail";
export { TenantSearch } from "./search/tenant-search";
export { AccountSync } from "./sync/account-sync";

const COMMIT_HEADER = "x-reader-commit";
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
    log.error("request failed", {
      method,
      path,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return apiError(500, "InternalServerError", errorMessage(error));
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
  return serve(request, env, result.tenant);
};

const route = (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/api/version") {
    return Promise.resolve(Response.json({ commit }, { headers: { [COMMIT_HEADER]: commit } }));
  }
  if (url.pathname.startsWith("/api/")) {
    return authenticated(request, env, url.pathname, handleApi);
  }
  if (isContentPath(url.pathname)) {
    return authenticated(request, env, url.pathname, serveContent);
  }
  return env.ASSETS.fetch(request);
};

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
      log.info("request", { method: request.method, path: url.pathname });
      const started = Date.now();
      const response = await Promise.resolve()
        .then(() => route(request, env, url))
        .catch(failed(request.method, url.pathname));
      log.info("response", {
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - started,
      });
      return tagged(response, correlationId);
    });
  },

  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await withLogContext({ correlationId: message.id }, async () => {
        log.info("queue message", {
          queue: batch.queue,
          id: message.id,
          attempts: message.attempts,
          ...describeSyncMessage(message.body),
        });
        await processSyncMessage(env, message.body);
        message.ack();
      });
    }
  },
} satisfies ExportedHandler<Env, SyncMessage>;
