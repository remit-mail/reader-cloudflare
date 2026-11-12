import {
  AUTH_BASE_PATH,
  CONNECTED_APPS_PATH,
  CONSENT_PATH,
  DEVICE_PATH,
  MCP_PATH,
  MCP_SCOPES,
  mcpResource,
} from "@remit/mcp-server/app";
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

const hasBearer = (request: Request): boolean =>
  /^Bearer\s/i.test(request.headers.get("authorization") ?? "");

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
  refused: (reason: string) => Response,
): Promise<Response> => {
  const verified = await verifyMcpBearer(request, (await mcpAuth(env)).auth, env);
  if (!verified.ok) {
    log.warn("mcp refused", { reason: verified.reason });
    return refused(verified.reason);
  }
  const { tenantId } = verified.tenant;
  annotateLog({ tenantId });
  const { success } = await env.TENANT_RATE_LIMIT.limit({ key: tenantId });
  if (!success) return rateLimited(RATE_LIMIT_PERIOD_SECONDS);
  return tenantMail(env, tenantId).mcp(request, verified.principal, currentCorrelationId());
};

export const serveMcpApi = (request: Request, env: Env): Promise<Response> => {
  if (hasBearer(request)) return Promise.resolve(unauthorized("use /mcp for an OAuth bearer"));
  return serveTools(withConnectingIp(request), env, unauthorized);
};

export const serveMcpMachine = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);
  const forwarded = withConnectingIp(request);
  if (pathname === MCP_PATH) {
    if (!hasBearer(request)) return challenge(env);
    return serveTools(forwarded, env, () => challenge(env, "invalid_token"));
  }
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
