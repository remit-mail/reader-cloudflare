import type { Env } from "./env";

export const tenantMail = (env: Env, tenantId: string) =>
  env.TENANT_MAIL.get(env.TENANT_MAIL.idFromName(tenantId));
