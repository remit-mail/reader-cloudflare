import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import type { MailboxItem } from "@remit/data-ports";
import type { IImapConnection, ImapBoxStatus } from "@remit/mailbox-service";
import { buildMessageBodyKey } from "@remit/storage-service";
import type { MailAccount, SyncedMessage } from "./types";

export interface StoredBodies {
  readonly connection: IImapConnection;
  readonly bytesRead: () => number;
}

const refuse = (operation: string) => (): never => {
  throw new Error(
    `${operation} is not served from stored bodies; the account sync object owns the IMAP connection`,
  );
};

export const storedBodies = (
  bucket: R2Bucket,
  account: MailAccount,
  mailbox: MailboxItem,
  messages: readonly SyncedMessage[],
): StoredBodies => {
  const byUid = new Map(messages.map((message) => [message.uid, message.messageId]));
  let bytes = 0;

  const status: ImapBoxStatus = {
    name: mailbox.fullPath,
    readOnly: true,
    uidvalidity: mailbox.uidValidity,
    uidnext: mailbox.uidNext,
    flags: [],
    permFlags: [],
    persistentUIDs: true,
    messages: { total: messages.length, new: 0 },
    newKeywords: false,
  };

  async function* fetchMessageBodies(
    uids: number[],
  ): AsyncGenerator<{ uid: number; source: Readable }> {
    for (const uid of uids) {
      const messageId = byUid.get(uid);
      if (messageId === undefined) throw new Error(`uid ${uid} is not in this body batch`);
      const key = buildMessageBodyKey(account.accountConfigId, account.accountId, messageId);
      const object = await bucket.get(key);
      if (object === null) throw new Error(`body object ${key} is missing`);
      const content = Buffer.from(await object.arrayBuffer());
      bytes += content.byteLength;
      yield { uid, source: Readable.from([content]) };
    }
  }

  const connection: IImapConnection = {
    state: "authenticated",
    isConnected: true,
    connect: async () => {},
    disconnect: async () => {},
    openBox: async (path: string) => {
      if (path !== mailbox.fullPath)
        throw new Error(`stored bodies hold ${mailbox.fullPath}, not ${path}`);
      return status;
    },
    closeBox: async () => {},
    fetchMessageBodies,
    getNamespaces: refuse("NAMESPACE"),
    listMailboxes: refuse("LIST"),
    search: refuse("SEARCH"),
    fetchMessages: refuse("FETCH"),
    supportsCondstore: refuse("CONDSTORE"),
    fetchMessagesChangedSince: refuse("FETCH CHANGEDSINCE"),
    fetchEnvelopeSnapshots: refuse("FETCH ENVELOPE"),
    fetchMessageBody: refuse("FETCH BODY"),
    addFlags: refuse("STORE"),
    removeFlags: refuse("STORE"),
    setFlags: refuse("STORE"),
    createMailbox: refuse("CREATE"),
    deleteMailbox: refuse("DELETE"),
    renameMailbox: refuse("RENAME"),
    subscribeMailbox: refuse("SUBSCRIBE"),
    unsubscribeMailbox: refuse("UNSUBSCRIBE"),
    moveMessages: refuse("MOVE"),
    copyMessages: refuse("COPY"),
    deleteMessages: refuse("EXPUNGE"),
    getMailboxStatus: refuse("STATUS"),
    append: refuse("APPEND"),
  };

  return { connection, bytesRead: () => bytes };
};
