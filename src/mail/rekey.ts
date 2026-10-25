import { base36uuidv5, REMIT_NAMESPACE } from "@remit/data-ports/id";
import type { SearchIndex } from "@remit/drizzle-service";
import {
  envelopeAddresses,
  envelopes,
  mailboxes,
  messageRecords,
  threadMessages,
} from "@remit/drizzle-sqlite-schema";
import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { v5 as uuidv5 } from "uuid";
import { log } from "../log";

const REKEYED = "mail-rekey-v1";

const envelopeIdOf = (messageId: string): string =>
  uuidv5(`envelope:${messageId}`, REMIT_NAMESPACE);

const rootBodyPartIdOf = (messageId: string): string => uuidv5(`${messageId}:0`, REMIT_NAMESPACE);

const threadMessageIdOf = (threadId: string, messageId: string): string =>
  base36uuidv5(`threadmsg:${threadId}:${messageId}`, REMIT_NAMESPACE);

const envelopeAddressIdOf = (messageId: string, role: string, order: number): string =>
  uuidv5(`envelopeaddress:${messageId}:${role}:${order}`, REMIT_NAMESPACE);

interface RekeyCounts {
  readonly messages: number;
  readonly envelopes: number;
  readonly threadMessages: number;
  readonly envelopeAddresses: number;
  readonly mailboxes: number;
}

type MailDb = DrizzleSqliteDODatabase<Record<string, unknown>>;

const rekeyRows = (db: MailDb): RekeyCounts =>
  db.transaction((tx) => {
    let messages = 0;
    let envelopeCount = 0;
    const stored = tx
      .select({
        messageId: messageRecords.messageId,
        envelopeId: messageRecords.envelopeId,
        rootBodyPartId: messageRecords.rootBodyPartId,
      })
      .from(messageRecords)
      .all();
    for (const message of stored) {
      const envelopeId = envelopeIdOf(message.messageId);
      const rootBodyPartId = rootBodyPartIdOf(message.messageId);
      if (message.envelopeId === envelopeId && message.rootBodyPartId === rootBodyPartId) continue;
      envelopeCount += tx
        .update(envelopes)
        .set({ envelopeId })
        .where(eq(envelopes.messageId, message.messageId))
        .returning({ envelopeId: envelopes.envelopeId })
        .all().length;
      tx.update(messageRecords)
        .set({ envelopeId, rootBodyPartId })
        .where(eq(messageRecords.messageId, message.messageId))
        .run();
      messages += 1;
    }
    let threadCount = 0;
    const threads = tx
      .select({
        threadMessageId: threadMessages.threadMessageId,
        threadId: threadMessages.threadId,
        messageId: threadMessages.messageId,
      })
      .from(threadMessages)
      .all();
    for (const thread of threads) {
      const threadMessageId = threadMessageIdOf(thread.threadId, thread.messageId);
      if (thread.threadMessageId === threadMessageId) continue;
      tx.update(threadMessages)
        .set({ threadMessageId })
        .where(eq(threadMessages.threadMessageId, thread.threadMessageId))
        .run();
      threadCount += 1;
    }
    let addressCount = 0;
    const addresses = tx
      .select({
        envelopeAddressId: envelopeAddresses.envelopeAddressId,
        messageId: envelopeAddresses.messageId,
        addressRole: envelopeAddresses.addressRole,
        addressOrder: envelopeAddresses.addressOrder,
      })
      .from(envelopeAddresses)
      .all();
    for (const address of addresses) {
      const envelopeAddressId = envelopeAddressIdOf(
        address.messageId,
        address.addressRole,
        address.addressOrder,
      );
      if (address.envelopeAddressId === envelopeAddressId) continue;
      tx.update(envelopeAddresses)
        .set({ envelopeAddressId })
        .where(eq(envelopeAddresses.envelopeAddressId, address.envelopeAddressId))
        .run();
      addressCount += 1;
    }
    const settled = tx
      .update(mailboxes)
      .set({ syncStatus: "synced" })
      .where(eq(mailboxes.syncStatus, "pending"))
      .returning({ mailboxId: mailboxes.mailboxId })
      .all().length;
    return {
      messages,
      envelopes: envelopeCount,
      threadMessages: threadCount,
      envelopeAddresses: addressCount,
      mailboxes: settled,
    };
  });

export const rekeyMail = async (
  storage: DurableObjectStorage,
  db: MailDb,
  searchIndex: SearchIndex,
  objectId: string,
): Promise<void> => {
  const done = storage.kv.get(REKEYED);
  const counts = done === undefined ? rekeyRows(db) : null;
  const indexed = (await searchIndex.needsRebuild()) ? await searchIndex.rebuild() : null;
  if (counts === null) {
    if (indexed !== null)
      log.warn("search index rebuilt", { event: "mail.reindex", objectId, indexed });
    return;
  }
  storage.kv.put(REKEYED, Date.now());
  log.info("mail rekeyed", { event: "mail.rekey", objectId, ...counts, indexed: indexed ?? 0 });
};
