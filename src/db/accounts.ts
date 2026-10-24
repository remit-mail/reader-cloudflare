import type { CreateAccountInputSchema } from "@remit/api-zod-schemas";
import { generateBase36Id } from "@remit/drizzle-sqlite-schema";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { type DecryptResult, decryptSecret, encryptSecret } from "../crypto/envelope";
import type { Env } from "../env";
import { log } from "../log";
import type { MailAccount } from "../mail/types";
import { type AppDb, runBatch } from "./client";
import { accountConfigs, accounts, credentials, tenantAccounts } from "./schema";

export type AccountRow = typeof accounts.$inferSelect;

export type AccountConfigRow = typeof accountConfigs.$inferSelect;

export interface NewAccount {
  readonly input: z.infer<typeof CreateAccountInputSchema>;
  readonly password: string;
}

const selectAccounts = (db: AppDb, tenantId: string, ...conditions: SQL[]) =>
  db
    .select({ account: accounts })
    .from(tenantAccounts)
    .innerJoin(accounts, eq(accounts.accountId, tenantAccounts.accountId))
    .where(and(eq(tenantAccounts.tenantId, tenantId), isNull(accounts.deletedAt), ...conditions))
    .orderBy(asc(accounts.createdAt));

export const listAccounts = async (db: AppDb, tenantId: string): Promise<AccountRow[]> => {
  const rows = await selectAccounts(db, tenantId);
  return rows.map((row) => row.account);
};

export const getAccount = async (
  db: AppDb,
  tenantId: string,
  accountId: string,
): Promise<AccountRow | undefined> => {
  const [row] = await selectAccounts(db, tenantId, eq(tenantAccounts.accountId, accountId));
  return row?.account;
};

export const toMailAccount = (tenantId: string, account: AccountRow): MailAccount => ({
  tenantId,
  accountId: account.accountId,
  accountConfigId: account.accountConfigId,
});

export const ensureAccountConfig = async (
  db: AppDb,
  tenantId: string,
): Promise<AccountConfigRow> => {
  const [existing] = await db
    .select()
    .from(accountConfigs)
    .where(eq(accountConfigs.userId, tenantId))
    .orderBy(asc(accountConfigs.createdAt))
    .limit(1);
  if (existing !== undefined) return existing;
  const now = Date.now();
  const [created] = await db
    .insert(accountConfigs)
    .values({
      accountConfigId: generateBase36Id(),
      userId: tenantId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (created === undefined) throw new Error("account config missing after insert");
  log.info("account config created", { tenantId, accountConfigId: created.accountConfigId });
  return created;
};

export const createAccount = async (
  env: Env,
  db: AppDb,
  tenantId: string,
  { input, password }: NewAccount,
): Promise<AccountRow> => {
  const now = Date.now();
  const config = await ensureAccountConfig(db, tenantId);
  const accountId = generateBase36Id();
  const username = input.username ?? input.email;
  const smtpHost = input.smtpHost ?? "";
  const sealed = await encryptSecret(env, tenantId, password);
  const row: AccountRow = {
    accountId,
    accountConfigId: config.accountConfigId,
    username,
    email: input.email,
    authType: "password",
    syncedServices: ["Mail"],
    grantedScopes: [],
    passwordHash: null,
    oauthRefreshTokenHash: null,
    oauthTokenUpdatedAt: null,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapTls: input.imapTls,
    imapStartTls: input.imapStartTls,
    smtpEnabled: input.smtpEnabled ?? smtpHost !== "",
    smtpHost,
    smtpPort: input.smtpPort ?? 587,
    smtpTls: input.smtpTls ?? false,
    smtpStartTls: input.smtpStartTls ?? true,
    smtpUsername: input.smtpUsername ?? username,
    smtpPasswordHash: null,
    isActive: true,
    connectionState: "not_authenticated",
    lastConnectedAt: null,
    lastSyncAt: null,
    lastError: null,
    syncPhase: "idle",
    mailboxCountTotal: null,
    mailboxCountSynced: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await runBatch(db, [
    db.insert(accounts).values(row),
    db.insert(tenantAccounts).values({ tenantId, accountId }),
    db.insert(credentials).values({
      accountId,
      keyVersion: sealed.keyVersion,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
    }),
  ]);
  log.info("credential encrypted", { tenantId, accountId, keyVersion: sealed.keyVersion });
  return row;
};

export const decryptCredential = async (
  env: Env,
  db: AppDb,
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

export type SyncOutcome =
  | { readonly ok: true; readonly mailboxes: number }
  | { readonly ok: false; readonly reason: string };

export const recordSyncOutcome = async (
  db: AppDb,
  accountId: string,
  outcome: SyncOutcome,
): Promise<void> => {
  const now = Date.now();
  if (!outcome.ok) {
    await db
      .update(accounts)
      .set({ syncPhase: "error", lastError: outcome.reason, updatedAt: now })
      .where(eq(accounts.accountId, accountId));
    return;
  }
  await db
    .update(accounts)
    .set({
      connectionState: "authenticated",
      syncPhase: "complete",
      lastConnectedAt: now,
      lastSyncAt: now,
      lastError: null,
      mailboxCountTotal: outcome.mailboxes,
      mailboxCountSynced: outcome.mailboxes,
      updatedAt: now,
    })
    .where(eq(accounts.accountId, accountId));
};
