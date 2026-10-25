import { and, eq } from "drizzle-orm";
import { type DecryptResult, decryptSecret, encryptSecret } from "../crypto/envelope";
import type { Env } from "../env";
import { log } from "../log";
import type { AppStore } from "./client";
import { credentials, tenantAccounts } from "./schema";

export const storeCredential = async (
  env: Env,
  { db, batch }: AppStore,
  tenantId: string,
  accountId: string,
  password: string,
): Promise<void> => {
  const sealed = await encryptSecret(env, tenantId, password);
  const credential = {
    keyVersion: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
  };
  await batch([
    db.insert(tenantAccounts).values({ tenantId, accountId }).onConflictDoNothing(),
    db
      .insert(credentials)
      .values({ accountId, ...credential })
      .onConflictDoUpdate({ target: credentials.accountId, set: credential }),
  ]);
  log.info("credential encrypted", { tenantId, accountId, keyVersion: sealed.keyVersion });
};

export const decryptCredential = async (
  env: Env,
  { db }: AppStore,
  tenantId: string,
  accountId: string,
): Promise<DecryptResult> => {
  const [row] = await db
    .select({
      accountId: credentials.accountId,
      keyVersion: credentials.keyVersion,
      ciphertext: credentials.ciphertext,
      iv: credentials.iv,
    })
    .from(credentials)
    .innerJoin(tenantAccounts, eq(tenantAccounts.accountId, credentials.accountId))
    .where(and(eq(tenantAccounts.tenantId, tenantId), eq(credentials.accountId, accountId)));
  if (row === undefined) return { ok: false, reason: "credential not found" };
  return decryptSecret(env, tenantId, row);
};
