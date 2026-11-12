import {
  AUTH_BASE_PATH,
  CONNECTED_APPS_PATH,
  CONSENT_PATH,
  DEVICE_PATH,
  MCP_PATH,
  MCP_SCOPES,
  type McpPrincipal,
  mcpResource,
} from "@remit/mcp-server/app";
import { requireServiceTenant, type Tenant } from "../access";
import { RATE_LIMIT_PERIOD_SECONDS } from "../api/host-limits";
import { API_ROOT } from "../api/paths";
import type { Env } from "../env";
import { rateLimited, unauthorized } from "../http";
import { annotateLog, currentCorrelationId, log } from "../log";
import { tenantMail } from "../stubs";
import { mcpAuth, withConnectingIp } from "./auth";
import { verifyMcpBearer } from "./verify";

export const MCP_API_PATH = `${API_ROOT}/mcp`;

const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`;

const PAGE_PATHS: ReadonlySet<string> = new Set([CONSENT_PATH, DEVICE_PATH, CONNECTED_APPS_PATH]);

export const isMcpPagePath = (path: string): boolean => PAGE_PATHS.has(path);

export const isMcpMachinePath = (path: string): boolean =>
  path === MCP_PATH ||
  path === AUTHORIZATION_SERVER_METADATA_PATH ||
  path === PROTECTED_RESOURCE_METADATA_PATH ||
  path === RESOURCE_METADATA_PATH ||
  path.startsWith(`${AUTH_BASE_PATH}/`);

const bearerOf = (request: Request): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

const challenge = (env: Env, error?: string): Response =>
  Response.json(
    { error: error ?? "unauthorized", resource: mcpResource(env.PUBLIC_ORIGIN) },
    {
      status: 401,
      headers: {
        "www-authenticate": [
          "Bearer",
          ` resource_metadata="${env.PUBLIC_ORIGIN}${RESOURCE_METADATA_PATH}",`,
          ` scope="${MCP_SCOPES.join(" ")}"`,
          error ? `, error="${error}"` : "",
        ].join(""),
      },
    },
  );

const serveTools = async (
  request: Request,
  env: Env,
  tenant: Tenant,
  principal: McpPrincipal,
): Promise<Response> => {
  annotateLog({ tenantId: tenant.tenantId });
  const { success } = await env.TENANT_RATE_LIMIT.limit({ key: tenant.tenantId });
  if (!success) return rateLimited(RATE_LIMIT_PERIOD_SECONDS);
  return tenantMail(env, tenant.tenantId).mcp(request, principal, currentCorrelationId());
};

export const serveMcpApi = async (request: Request, env: Env): Promise<Response> => {
  if (request.headers.has("authorization")) return unauthorized("use /mcp for an OAuth bearer");
  const result = await requireServiceTenant(request, env);
  if (!result.ok) {
    log.warn("mcp refused", { reason: result.reason });
    return unauthorized(result.reason);
  }
  const { tenant } = result;
  return serveTools(withConnectingIp(request), env, tenant, {
    userId: tenant.tenantId,
    scopes: MCP_SCOPES,
  });
};

const serveBearer = async (request: Request, env: Env): Promise<Response> => {
  const bearer = bearerOf(request);
  if (bearer === undefined) return challenge(env);
  const verified = await verifyMcpBearer(bearer, (await mcpAuth(env)).auth, env);
  if (!verified.ok) {
    log.warn("mcp refused", { reason: verified.reason });
    return challenge(env, "invalid_token");
  }
  return serveTools(withConnectingIp(request), env, verified.tenant, verified.principal);
};

export const serveMcpMachine = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === MCP_PATH) return serveBearer(request, env);
  const forwarded = withConnectingIp(request);
  if (pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
    return (await mcpAuth(env)).routes.serverMetadata(forwarded);
  }
  if (pathname === PROTECTED_RESOURCE_METADATA_PATH || pathname === RESOURCE_METADATA_PATH) {
    return Response.json({
      resource: mcpResource(env.PUBLIC_ORIGIN),
      authorization_servers: [env.PUBLIC_ORIGIN],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
    });
  }
  return (await mcpAuth(env)).routes.handle(forwarded);
};

export const serveMcpPage = (request: Request, env: Env, tenantId: string): Promise<Response> =>
  tenantMail(env, tenantId).mcpPage(withConnectingIp(request), tenantId, currentCorrelationId());
