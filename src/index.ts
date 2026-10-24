import { requireTenant } from "./access";
import { api } from "./api";
import { commit } from "./commit";
import type { Env, SyncMessage } from "./env";
import { log } from "./log";
import { isMailPath, mailApi } from "./mail/routes";
import { isSendPath, sendApi } from "./mail/send";
import { isSearchPath, searchApi } from "./search/routes";
import { processSyncMessage } from "./sync/process";
import { isSyncPath, syncApi } from "./sync/routes";

export { TenantMail } from "./mail/tenant-mail";
export { TenantSearch } from "./search/tenant-search";
export { AccountSync } from "./sync/account-sync";

const COMMIT_HEADER = "x-reader-commit";

const handleApi = async (request: Request, env: Env, path: string): Promise<Response> => {
  const result = await requireTenant(request, env);
  if (!result.ok) {
    log.warn("access denied", { path, reason: result.reason });
    return Response.json({ error: "unauthorized", reason: result.reason }, { status: 401 });
  }
  log.info("authenticated request", { path, tenantId: result.tenant.tenantId });
  if (isMailPath(path)) return mailApi(request, env, path, result.tenant);
  if (isSendPath(path)) return sendApi(request, env, path, result.tenant);
  if (isSyncPath(path)) return syncApi(request, env, path, result.tenant);
  if (isSearchPath(path)) return searchApi(request, env, path, result.tenant);
  return api(request, env, path, result.tenant);
};

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    log.info("request", { method: request.method, path: url.pathname });
    if (url.pathname === "/api/version") {
      return Response.json({ commit }, { headers: { [COMMIT_HEADER]: commit } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
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
