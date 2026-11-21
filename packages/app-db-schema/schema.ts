import { blob, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const deadLetters = sqliteTable("dead_letter", {
  deadLetterId: text("dead_letter_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  type: text("type").notNull(),
  attempts: integer("attempts").notNull(),
  body: text("body").notNull(),
});

export const classificationDefaults = sqliteTable("classification_default", {
  classificationDefaultId: text("classification_default_id").primaryKey(),
  presetId: text("preset_id").notNull(),
  model: text("model").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeySealed: blob("api_key_sealed", { mode: "buffer" }).$type<Uint8Array>().notNull(),
  iv: blob("iv", { mode: "buffer" }).$type<Uint8Array>().notNull(),
  keyVersion: integer("key_version").notNull(),
  dailyLimit: integer("daily_limit").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  version: integer("version").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const tenantEmails = sqliteTable(
  "tenant_email",
  {
    tenantId: text("tenant_id").primaryKey(),
    email: text("email").notNull(),
  },
  (table) => [uniqueIndex("tenant_email_email").on(table.email)],
);
