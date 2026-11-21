import {
  CLIENT_IP_HEADER,
  createMcpAuth,
  type McpAuthServer,
  type McpIdentity,
  mcpDatabase,
} from "@remit/mcp-server/app";
import { requireTenant } from "../access";
import { openAppDb } from "../db/client";
import { mcpAccount, mcpUser } from "../db/schema";
import type { Env } from "../env";
import { log } from "../log";
import { isTenantDisabled, isTenantOperator } from "../tenant-email";

const CONNECTING_IP_HEADER = "cf-connecting-ip";

export const withConnectingIp = (request: Request): Request => {
  const headers = new Headers(request.headers);
  const connectingIp = request.headers.get(CONNECTING_IP_HEADER);
  if (connectingIp === null) headers.delete(CLIENT_IP_HEADER);
  else headers.set(CLIENT_IP_HEADER, connectingIp);
  return new Request(request, { headers });
};

const accessIdentity = (env: Env, origin: string): McpIdentity => ({
  isDisabled: (userId) => isTenantDisabled(env.DB, env.LOGIN_OPERATOR, userId),
  isOperator: (userId) => isTenantOperator(env.DB, env.LOGIN_OPERATOR, userId),
  audit: async (record) => log.info("mcp identity audit", { event: "mcp.audit", ...record }),
  browser: {
    subjectOf: async (headers) => {
      const result = await requireTenant(new Request(origin, { headers }), env);
      return result.ok ? { id: result.tenant.tenantId } : undefined;
    },
  },
});

export const mcpAuth = async (env: Env): Promise<McpAuthServer> => {
  const origin = env.PUBLIC_ORIGIN;
  return createMcpAuth(
    { origin, secret: await env.MCP_AUTH_SECRET.get(), signInEnabled: true },
    mcpDatabase(openAppDb(env.DB), { user: mcpUser, account: mcpAccount }),
    accessIdentity(env, origin),
  );
};
