import {
  AUTH_BASE_PATH,
  CONNECTED_APPS_PATH,
  CONSENT_PATH,
  challenge,
  createMcpPages,
  DEVICE_PATH,
  MCP_PATH,
  MCP_SCOPES,
  type McpPrincipal,
  type McpResourceConfig,
  protectedResourceMetadata,
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

const resourceConfig = (env: Env): McpResourceConfig => ({ origin: env.PUBLIC_ORIGIN });

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
  if (bearer === undefined) return challenge(resourceConfig(env), "unauthorized");
  const verified = await verifyMcpBearer(bearer, (await mcpAuth(env)).auth, env);
  if (!verified.ok) {
    log.warn("mcp refused", { reason: verified.reason });
    return challenge(resourceConfig(env), "invalid_token");
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
    return protectedResourceMetadata(resourceConfig(env));
  }
  return (await mcpAuth(env)).routes.handle(forwarded);
};

export const serveMcpPage = async (request: Request, env: Env): Promise<Response> =>
  createMcpPages({ origin: env.PUBLIC_ORIGIN, authRoutes: (await mcpAuth(env)).routes })(
    withConnectingIp(request),
  );
