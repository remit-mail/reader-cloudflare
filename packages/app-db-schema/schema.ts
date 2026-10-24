import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenantAccounts = sqliteTable(
  "tenant_account",
  {
    tenantId: text("tenant_id").notNull(),
    accountId: text("account_id").notNull().unique(),
  },
  (table) => [
    primaryKey({ name: "tenant_account_pk", columns: [table.tenantId, table.accountId] }),
  ],
);

export const credentials = sqliteTable(
  "credential",
  {
    accountId: text("account_id").primaryKey(),
    keyVersion: integer("key_version").notNull(),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
  },
  (table) => [index("credential_by_key_version").on(table.keyVersion)],
);

export const tenantKeys = sqliteTable(
  "tenant_key",
  {
    tenantId: text("tenant_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    wrappedKey: blob("wrapped_key", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
  },
  (table) => [primaryKey({ name: "tenant_key_pk", columns: [table.tenantId, table.keyVersion] })],
);
