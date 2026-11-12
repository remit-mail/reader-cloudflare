import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  createBetterAuthTokenVerifier,
  type McpAuth,
  type McpPrincipal,
} from "@remit/mcp-server/app";
import type { Tenant } from "../access";
import type { Env } from "../env";

export type McpBearerResult =
  | { readonly ok: true; readonly tenant: Tenant; readonly principal: McpPrincipal }
  | { readonly ok: false; readonly reason: string };

export const verifyMcpBearer = async (
  bearer: string,
  auth: McpAuth,
  env: Env,
): Promise<McpBearerResult> => {
  const verification = await createBetterAuthTokenVerifier(auth, env.PUBLIC_ORIGIN).verify(bearer);
  if (!verification.ok) return verification;
  const subject = verification.principal.userId;
  return {
    ok: true,
    tenant: { tenantId: subject, accountConfigId: deriveAccountConfigId(subject), email: subject },
    principal: verification.principal,
  };
};
