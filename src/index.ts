import { requireTenant, type Tenant } from "./access";
import { commit } from "./commit";
import type { Env, SyncMessage } from "./env";
import { log } from "./log";
import { spike } from "./spike";

const COMMIT_HEADER = "x-reader-commit";

const api = (path: string, tenant: Tenant): Response => {
  if (path === "/api/me") return Response.json({ tenantId: tenant.tenantId, email: tenant.email });
  return Response.json({ error: "not found" }, { status: 404 });
};

const handleApi = async (request: Request, env: Env, path: string): Promise<Response> => {
  const result = await requireTenant(request, env);
  if (!result.ok) {
    log.warn("access denied", { path, reason: result.reason });
    return Response.json({ error: "unauthorized", reason: result.reason }, { status: 401 });
  }
  log.info("authenticated request", { path, tenantId: result.tenant.tenantId });
  return api(path, result.tenant);
};

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    log.info("request", { method: request.method, path: url.pathname });
    const spiked = spike(url.pathname);
    if (spiked !== undefined) return spiked;
    if (url.pathname === "/api/version") {
      return Response.json({ commit }, { headers: { [COMMIT_HEADER]: commit } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    return new Response("remit reader\n", {
      headers: { "content-type": "text/plain", [COMMIT_HEADER]: commit },
    });
  },

  queue(batch: MessageBatch<SyncMessage>): void {
    for (const message of batch.messages) {
      log.info("queue message", {
        queue: batch.queue,
        id: message.id,
        attempts: message.attempts,
        body: message.body,
      });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, SyncMessage>;
