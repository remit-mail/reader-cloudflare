import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const searchMessages = sqliteTable(
  "search_message",
  {
    ftsRowid: integer("fts_rowid").primaryKey({ autoIncrement: true }),
    messageId: text("message_id").notNull().unique(),
    accountId: text("account_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
  },
  (table) => [index("search_message_by_account_id").on(table.accountId, table.mailboxId)],
);
