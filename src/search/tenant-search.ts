import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import migrations from "../../migrations/search/migrations";
import { inList } from "../db/in-list";
import type { Env } from "../env";
import { log } from "../log";
import type { MailAccount } from "../mail/types";
import * as schema from "./schema";
import { searchMessages } from "./schema";
import type { SearchDocument, SearchHit, SearchOptions } from "./types";

type SearchDb = DrizzleSqliteDODatabase<typeof schema>;

type Tx = Parameters<Parameters<SearchDb["transaction"]>[0]>[0];

const messageFts = sqliteTable("message_fts", {
  rowid: integer("rowid").notNull(),
  messageId: text("message_id").notNull(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull(),
  subject: text("subject").notNull(),
  fromText: text("from_text").notNull(),
  toText: text("to_text").notNull(),
  bodyText: text("body_text").notNull(),
});

const rank = sql<number>`bm25(${messageFts}, 0, 0, 0, 10, 5, 2, 1)`;

const SEARCHABLE = /[\p{L}\p{N}]/u;

const matchExpression = (query: string): string | null => {
  const terms = query
    .split(/\s+/)
    .filter((term) => SEARCHABLE.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"*`);
  if (terms.length === 0) return null;
  return terms.join(" ");
};

const removeMessage = (tx: Tx, accountId: string, messageId: string): void => {
  const existing = tx
    .select({ ftsRowid: searchMessages.ftsRowid })
    .from(searchMessages)
    .where(and(eq(searchMessages.messageId, messageId), eq(searchMessages.accountId, accountId)))
    .get();
  if (existing === undefined) return;
  tx.delete(messageFts).where(eq(messageFts.rowid, existing.ftsRowid)).run();
  tx.delete(searchMessages).where(eq(searchMessages.ftsRowid, existing.ftsRowid)).run();
};

const writeDocument = (tx: Tx, accountId: string, doc: SearchDocument): void => {
  removeMessage(tx, accountId, doc.messageId);
  const inserted = tx
    .insert(searchMessages)
    .values({ messageId: doc.messageId, accountId, mailboxId: doc.mailboxId })
    .returning({ ftsRowid: searchMessages.ftsRowid })
    .get();
  tx.insert(messageFts)
    .values({
      rowid: inserted.ftsRowid,
      messageId: doc.messageId,
      accountId,
      mailboxId: doc.mailboxId,
      subject: doc.subject,
      fromText: doc.from,
      toText: doc.to,
      bodyText: doc.bodyText,
    })
    .run();
};

export class TenantSearch extends DurableObject<Env> {
  private readonly db: SearchDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  indexMessages(account: MailAccount, docs: readonly SearchDocument[]): number {
    this.db.transaction((tx) => {
      for (const doc of docs) writeDocument(tx, account.accountId, doc);
    });
    log.info("messages indexed", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      count: docs.length,
    });
    return docs.length;
  }

  removeMessages(account: MailAccount, messageIds: readonly string[]): number {
    this.db.transaction((tx) => {
      for (const messageId of messageIds) removeMessage(tx, account.accountId, messageId);
    });
    log.info("messages removed from index", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      count: messageIds.length,
    });
    return messageIds.length;
  }

  search(options: SearchOptions): readonly SearchHit[] {
    const expression = matchExpression(options.query);
    if (expression === null || options.accountIds.length === 0) return [];
    const mailbox: SQL | undefined =
      options.mailboxIds === null ? undefined : inList(messageFts.mailboxId, options.mailboxIds);
    return this.db
      .select({ messageId: messageFts.messageId, mailboxId: messageFts.mailboxId, rank })
      .from(messageFts)
      .where(
        and(
          sql`${messageFts} MATCH ${expression}`,
          inList(messageFts.accountId, options.accountIds),
          mailbox,
        ),
      )
      .orderBy(asc(rank))
      .limit(options.limit)
      .all();
  }

  clear(account: MailAccount): void {
    this.db.transaction((tx) => {
      const owned = tx
        .select({ ftsRowid: searchMessages.ftsRowid })
        .from(searchMessages)
        .where(eq(searchMessages.accountId, account.accountId));
      tx.delete(messageFts).where(inArray(messageFts.rowid, owned)).run();
      tx.delete(searchMessages).where(eq(searchMessages.accountId, account.accountId)).run();
    });
    log.info("search index cleared", { tenantId: account.tenantId, accountId: account.accountId });
  }
}
