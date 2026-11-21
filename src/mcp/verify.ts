import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  createBetterAuthTokenVerifier,
  type McpAuth,
  type McpPrincipal,
} from "@remit/mcp-server/app";
import { isOperator, type Tenant } from "../access";
import type { Env } from "../env";

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
  if (!verification.ok) return verification;
  const subject = verification.principal.userId;
  const tenant = {
    tenantId: subject,
    accountConfigId: deriveAccountConfigId(subject),
    email: subject,
    service: false,
  };
  return {
    ok: true,
    tenant,
    principal: verification.principal,
    operator: verification.principal.scopes.includes("operator") && isOperator(tenant, env),
  };
};
