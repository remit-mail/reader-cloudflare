import { generateBase36Id } from "@remit/drizzle-sqlite-schema";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type DecryptResult, decryptSecret, encryptSecret } from "../crypto/envelope";
import type { Env } from "../env";
import { log } from "../log";
import { type AppDb, runBatch } from "./client";
import { accountConfigs, accounts, credentials, tenantAccounts } from "./schema";

const server = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
});

export const newAccountSchema = z.object({
  name: z.string().min(1),
  imap: server,
  smtp: server,
  username: z.string().min(1),
  password: z.string().min(1),
});

export type NewAccount = z.infer<typeof newAccountSchema>;

export interface AccountView {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
  readonly username: string;
  readonly imap: z.infer<typeof server>;
  readonly smtp: z.infer<typeof server>;
  readonly connectionState: string;
  readonly createdAt: number;
}

const columns = {
  accountId: accounts.accountId,
  name: accountConfigs.name,
  email: accounts.email,
  username: accounts.username,
  imapHost: accounts.imapHost,
  imapPort: accounts.imapPort,
  imapTls: accounts.imapTls,
  smtpHost: accounts.smtpHost,
  smtpPort: accounts.smtpPort,
  smtpTls: accounts.smtpTls,
  connectionState: accounts.connectionState,
  createdAt: accounts.createdAt,
};

const selectAccounts = (db: AppDb, tenantId: string, ...conditions: SQL[]) =>
  db
    .select(columns)
    .from(tenantAccounts)
    .innerJoin(accounts, eq(accounts.accountId, tenantAccounts.accountId))
    .innerJoin(accountConfigs, eq(accountConfigs.accountConfigId, accounts.accountConfigId))
    .where(and(eq(tenantAccounts.tenantId, tenantId), isNull(accounts.deletedAt), ...conditions));

type AccountRow = Awaited<ReturnType<typeof selectAccounts>>[number];

const toView = (row: AccountRow): AccountView => ({
  accountId: row.accountId,
  name: row.name ?? row.email,
  email: row.email,
  username: row.username,
  imap: { host: row.imapHost, port: row.imapPort, secure: row.imapTls },
  smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpTls },
  connectionState: row.connectionState,
  createdAt: row.createdAt,
});

export const listAccounts = async (db: AppDb, tenantId: string): Promise<AccountView[]> => {
  const rows = await selectAccounts(db, tenantId).orderBy(accounts.createdAt);
  return rows.map(toView);
};

export const getAccount = async (
  db: AppDb,
  tenantId: string,
  accountId: string,
): Promise<AccountView | undefined> => {
  const [row] = await selectAccounts(db, tenantId, eq(tenantAccounts.accountId, accountId));
  return row === undefined ? undefined : toView(row);
};

export const createAccount = async (
  env: Env,
  db: AppDb,
  tenantId: string,
  input: NewAccount,
): Promise<AccountView> => {
  const now = Date.now();
  const accountConfigId = generateBase36Id();
  const accountId = generateBase36Id();
  const sealed = await encryptSecret(env, tenantId, input.password);
  await runBatch(db, [
    db.insert(accountConfigs).values({
      accountConfigId,
      userId: tenantId,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(accounts).values({
      accountId,
      accountConfigId,
      username: input.username,
      email: input.username,
      syncedServices: ["Mail"],
      imapHost: input.imap.host,
      imapPort: input.imap.port,
      imapTls: input.imap.secure,
      imapStartTls: !input.imap.secure,
      smtpEnabled: true,
      smtpHost: input.smtp.host,
      smtpPort: input.smtp.port,
      smtpTls: input.smtp.secure,
      smtpStartTls: !input.smtp.secure,
      smtpUsername: input.username,
      isActive: true,
      connectionState: "not_authenticated",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(tenantAccounts).values({ tenantId, accountId }),
    db.insert(credentials).values({
      accountId,
      keyVersion: sealed.keyVersion,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
    }),
  ]);
  log.info("credential encrypted", { tenantId, accountId, keyVersion: sealed.keyVersion });
  return {
    accountId,
    name: input.name,
    email: input.username,
    username: input.username,
    imap: input.imap,
    smtp: input.smtp,
    connectionState: "not_authenticated",
    createdAt: now,
  };
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
