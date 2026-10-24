import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const syncSkips = sqliteTable(
  "sync_skip",
  {
    mailboxId: text("mailbox_id").notNull(),
    uid: integer("uid", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.uid] })],
);
