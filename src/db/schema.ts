import { customType, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export {
  accountConfigs,
  accountSettings,
  accounts,
  filters,
  labels,
} from "@remit/drizzle-sqlite-schema";

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return Uint8Array.from(value);
  }
  throw new Error("blob column did not return bytes");
};

const bytes = customType<{ data: Uint8Array; driverData: unknown }>({
  dataType: () => "blob",
  toDriver: (value) => value,
  fromDriver: toBytes,
});

export const tenantAccounts = sqliteTable(
  "tenant_account",
  {
    tenantId: text("tenant_id").notNull(),
    accountId: text("account_id").notNull().unique(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.accountId] })],
);

export const credentials = sqliteTable(
  "credential",
  {
    accountId: text("account_id").notNull().primaryKey(),
    keyVersion: integer("key_version").notNull(),
    ciphertext: bytes("ciphertext").notNull(),
    iv: bytes("iv").notNull(),
  },
  (table) => [index("credential_by_key_version").on(table.keyVersion)],
);

export const tenantKeys = sqliteTable(
  "tenant_key",
  {
    tenantId: text("tenant_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    wrappedKey: bytes("wrapped_key").notNull(),
    iv: bytes("iv").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.keyVersion] })],
);
