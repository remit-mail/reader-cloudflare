import type { Tenant } from "./access";
import { createAccount, getAccount, listAccounts, newAccountSchema } from "./db/accounts";
import { openAppDb } from "./db/client";
import type { Env } from "./env";

const ACCOUNT_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)$/;

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

const postAccount = async (request: Request, env: Env, tenant: Tenant): Promise<Response> => {
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = newAccountSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid account", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const account = await createAccount(openAppDb(env.DB), tenant.tenantId, parsed.data);
  return Response.json(account, { status: 201 });
};

export const api = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  if (path === "/api/me") return Response.json({ tenantId: tenant.tenantId, email: tenant.email });
  if (path === "/api/accounts" && request.method === "GET") {
    return Response.json(await listAccounts(openAppDb(env.DB), tenant.tenantId));
  }
  if (path === "/api/accounts" && request.method === "POST") {
    return postAccount(request, env, tenant);
  }
  const accountId = ACCOUNT_PATH.exec(path)?.[1];
  if (accountId === undefined || request.method !== "GET") return notFound();
  const account = await getAccount(openAppDb(env.DB), tenant.tenantId, accountId);
  if (account === undefined) return notFound();
  return Response.json(account);
};
