import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenantKeys = sqliteTable(
  "tenant_key",
  {
    tenantId: text("tenant_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    wrappedKey: blob("wrapped_key", { mode: "buffer" }).$type<Uint8Array>().notNull(),
    iv: blob("iv", { mode: "buffer" }).$type<Uint8Array>().notNull(),
  },
  (table) => [primaryKey({ name: "tenant_key_pk", columns: [table.tenantId, table.keyVersion] })],
);

export const tenantAccountConfigs = sqliteTable("tenant_account_config", {
  accountConfigId: text("account_config_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
});
