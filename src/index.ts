import { requireTenant } from "./access";
import { unauthorized } from "./api/respond";
import { handleApi } from "./api/router";
import { commit } from "./commit";
import { isContentPath, serveContent } from "./content/route";
import type { Env, SyncMessage } from "./env";
import { log } from "./log";
import { processSyncMessage } from "./sync/process";

export { TenantMail } from "./mail/tenant-mail";
export { TenantSearch } from "./search/tenant-search";
export { AccountSync } from "./sync/account-sync";

const COMMIT_HEADER = "x-reader-commit";

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

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    log.info("request", { method: request.method, path: url.pathname });
    if (url.pathname === "/api/version") {
      return Response.json({ commit }, { headers: { [COMMIT_HEADER]: commit } });
    }
    if (url.pathname.startsWith("/api/")) {
      return authenticated(request, env, url.pathname, handleApi);
    }
    if (isContentPath(url.pathname)) {
      return authenticated(request, env, url.pathname, serveContent);
    }
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      log.info("queue message", { queue: batch.queue, id: message.id, attempts: message.attempts });
      await processSyncMessage(env, message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, SyncMessage>;
