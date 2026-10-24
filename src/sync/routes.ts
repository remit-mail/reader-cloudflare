import type { Tenant } from "../access";
import { decryptCredential, getAccount } from "../db/accounts";
import { openAppDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";
import { openImap } from "../mail/imap-connect";
import { syncAccount } from "./dump";

const SYNC_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/sync$/;

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

const matchAccountId = (path: string): string | null => SYNC_PATH.exec(path)?.[1] ?? null;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isSyncPath = (path: string): boolean => matchAccountId(path) !== null;

export const syncApi = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  const accountId = matchAccountId(path);
  if (accountId === null || request.method !== "POST") return notFound();
  const db = openAppDb(env.DB);
  const account = await getAccount(db, tenant.tenantId, accountId);
  if (account === undefined) return notFound();
  const secret = await decryptCredential(env, db, tenant.tenantId, accountId);
  if (!secret.ok) {
    log.error("sync failed", { tenantId: tenant.tenantId, accountId, reason: secret.reason });
    return Response.json({ error: "sync failed", reason: secret.reason }, { status: 500 });
  }
  const mailAccount = {
    tenantId: tenant.tenantId,
    accountId,
    accountConfigId: account.accountConfigId,
  };
  const started = Date.now();
  const outcome = await openImap({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    username: account.username,
    password: secret.plaintext,
  })
    .then(async (client) => {
      try {
        return await syncAccount(env, client, mailAccount);
      } finally {
        client.close();
      }
    })
    .then(
      (summary) => ({ ok: true as const, summary }),
      (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
    );
  if (!outcome.ok) {
    log.error("sync failed", { tenantId: tenant.tenantId, accountId, reason: outcome.reason });
    return Response.json({ error: "sync failed", reason: outcome.reason }, { status: 502 });
  }
  log.info("sync finished", {
    tenantId: tenant.tenantId,
    accountId,
    ...outcome.summary,
    durationMs: Date.now() - started,
  });
  return Response.json(outcome.summary);
};
