import type { Env } from "./env";

export const tenantMail = (env: Env, tenantId: string) =>
  env.TENANT_MAIL.get(env.TENANT_MAIL.idFromName(tenantId));

export const tenantSearch = (env: Env, tenantId: string) =>
  env.TENANT_SEARCH.get(env.TENANT_SEARCH.idFromName(tenantId));

export const accountSync = (env: Env, tenantId: string, accountId: string) =>
  env.ACCOUNT_SYNC.get(env.ACCOUNT_SYNC.idFromName(`${tenantId}/${accountId}`));
