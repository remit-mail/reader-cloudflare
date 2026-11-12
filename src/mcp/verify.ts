import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  createBetterAuthTokenVerifier,
  MCP_SCOPES,
  type McpAuth,
  type McpPrincipal,
} from "@remit/mcp-server/app";
import { requireServiceTenant, type Tenant } from "../access";
import type { Env } from "../env";

export type McpBearerResult =
  | { readonly ok: true; readonly tenant: Tenant; readonly principal: McpPrincipal }
  | { readonly ok: false; readonly reason: string };

const bearerOf = (request: Request): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

const serviceTokenTenant = async (request: Request, env: Env): Promise<McpBearerResult> => {
  const result = await requireServiceTenant(request, env);
  if (!result.ok) return result;
  return {
    ok: true,
    tenant: result.tenant,
    principal: { userId: result.tenant.tenantId, scopes: MCP_SCOPES },
  };
};

export const verifyMcpBearer = async (
  request: Request,
  auth: McpAuth,
  env: Env,
): Promise<McpBearerResult> => {
  const bearer = bearerOf(request);
  if (bearer === undefined) return serviceTokenTenant(request, env);
  const verification = await createBetterAuthTokenVerifier(auth, env.PUBLIC_ORIGIN).verify(bearer);
  if (!verification.ok) return verification;
  const subject = verification.principal.userId;
  return {
    ok: true,
    tenant: { tenantId: subject, accountConfigId: deriveAccountConfigId(subject), email: "" },
    principal: verification.principal,
  };
};
