import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  createBetterAuthTokenVerifier,
  type McpAuth,
  type McpPrincipal,
} from "@remit/mcp-server/app";
import { hasOperatorGrant, type Tenant } from "../access";
import type { Env } from "../env";
import { emailOfTenant } from "../tenant-email";

export type McpBearerResult =
  | {
      readonly ok: true;
      readonly tenant: Tenant;
      readonly principal: McpPrincipal;
      readonly operator: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export const verifyMcpBearer = async (
  bearer: string,
  auth: McpAuth,
  env: Env,
): Promise<McpBearerResult> => {
  const verification = await createBetterAuthTokenVerifier(auth, env.PUBLIC_ORIGIN).verify(bearer);
  if (!verification.ok) return { ok: false, reason: verification.description };
  const subject = verification.principal.userId;
  const email = await emailOfTenant(env.DB, subject);
  if (email === undefined) return { ok: false, reason: "MCP subject has no recorded email" };
  const tenant = {
    tenantId: subject,
    accountConfigId: deriveAccountConfigId(subject),
    email,
    service: false,
  };
  return {
    ok: true,
    tenant,
    principal: verification.principal,
    operator: hasOperatorGrant(
      verification.principal.scopes,
      await env.LOGIN_OPERATOR.isOperator(email),
    ),
  };
};
