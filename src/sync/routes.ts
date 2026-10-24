import type { Tenant } from "../access";
import { decryptCredential, getAccount } from "../db/accounts";
import { openAppDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";

const SYNC_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/sync$/;

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

const matchAccountId = (path: string): string | null => SYNC_PATH.exec(path)?.[1] ?? null;

export const accountSync = (env: Env, tenantId: string, accountId: string) =>
  env.ACCOUNT_SYNC.get(env.ACCOUNT_SYNC.idFromName(`${tenantId}/${accountId}`));

export const isSyncPath = (path: string): boolean => matchAccountId(path) !== null;

export const syncApi = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  const accountId = matchAccountId(path);
  if (accountId === null) return notFound();
  if (request.method !== "GET" && request.method !== "POST") return notFound();
  const db = openAppDb(env.DB);
  const account = await getAccount(db, tenant.tenantId, accountId);
  if (account === undefined) return notFound();
  const sync = accountSync(env, tenant.tenantId, accountId);
  if (request.method === "GET") return Response.json(await sync.status());
  const secret = await decryptCredential(env, db, tenant.tenantId, accountId);
  if (!secret.ok) {
    log.error("sync failed", { tenantId: tenant.tenantId, accountId, reason: secret.reason });
    return Response.json({ error: "sync failed", reason: secret.reason }, { status: 500 });
  }
  const state = await sync.start(
    { tenantId: tenant.tenantId, accountId, accountConfigId: account.accountConfigId },
    {
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      username: account.username,
      password: secret.plaintext,
    },
  );
  return Response.json(state, { status: 202 });
};
