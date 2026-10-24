import type { ImapFlow, ListResponse } from "imapflow";
import type { Env } from "../env";
import { log } from "../log";
import { tenantMail } from "../mail/routes";
import type { MailAccount, MailboxInput, MailboxView, SpecialUse } from "../mail/types";
import { tenantSearch } from "../search/routes";
import { messageKey, toCustomMetadata } from "./messages";

const BATCH_SIZE = 25;
const MAILBOX_LIMIT = 200;
const INBOX = "INBOX";

const SPECIAL_USE: Readonly<Record<string, SpecialUse>> = {
  "\\All": "All",
  "\\Archive": "Archive",
  "\\Drafts": "Drafts",
  "\\Flagged": "Flagged",
  "\\Junk": "Junk",
  "\\Sent": "Sent",
  "\\Trash": "Trash",
  "\\Important": "Important",
};

const UNSELECTABLE = ["\\Noselect", "\\NonExistent"];

export interface MailboxSyncResult {
  readonly mailboxId: string;
  readonly path: string;
  readonly reset: boolean;
  readonly dumped: number;
  readonly batches: number;
}

export type BatchQueued = (dumped: number) => Promise<void>;

export interface ServerMailbox {
  readonly mailboxId: string;
  readonly entry: ListResponse;
  readonly uidValidity: number;
}

const isSelectable = (entry: ListResponse): boolean =>
  !UNSELECTABLE.some((flag) => entry.flags.has(flag));

const toSpecialUse = (entry: ListResponse): readonly SpecialUse[] => {
  const use = entry.specialUse === undefined ? undefined : SPECIAL_USE[entry.specialUse];
  return use === undefined ? [] : [use];
};

const toMailboxInput = (entry: ListResponse): MailboxInput => ({
  path: entry.path,
  delimiter: entry.delimiter ?? "",
  namespacePrefix: "",
  specialUse: toSpecialUse(entry),
  uidValidity: Number(entry.status?.uidValidity ?? 0n),
  uidNext: entry.status?.uidNext ?? 0,
  highestModseq: String(entry.status?.highestModseq ?? 0n),
  messageCount: entry.status?.messages ?? 0,
  unseenCount: entry.status?.unseen ?? 0,
});

const inboxFirst = (left: ListResponse, right: ListResponse): number => {
  if (left.path === INBOX) return -1;
  if (right.path === INBOX) return 1;
  return left.path.localeCompare(right.path);
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const toEpoch = (value: Date | string | undefined): number => {
  if (value === undefined) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

export const listServerMailboxes = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
): Promise<readonly ServerMailbox[]> => {
  const listed = await client.list({
    statusQuery: { messages: true, uidNext: true, uidValidity: true, unseen: true },
  });
  const selectable = listed.filter(isSelectable).sort(inboxFirst);
  const upserted = await tenantMail(env, account.tenantId).upsertMailboxes(
    account,
    selectable.map(toMailboxInput),
  );
  const ids = new Map(upserted.map((mailbox) => [mailbox.path, mailbox.mailboxId]));
  return selectable.flatMap((entry): ServerMailbox[] => {
    const mailboxId = ids.get(entry.path);
    if (mailboxId === undefined) return [];
    return [{ mailboxId, entry, uidValidity: Number(entry.status?.uidValidity ?? 0n) }];
  });
};

const dumpMessage = async (
  env: Env,
  client: ImapFlow,
  key: string,
  metadata: Record<string, string>,
  uid: number,
  size: number,
): Promise<void> => {
  const download = await client.download(String(uid), undefined, { uid: true });
  if (download.content === undefined) throw new Error(`uid ${uid} vanished during download`);
  const { readable, writable } = new FixedLengthStream(size);
  const upload = env.MAIL.put(key, readable, { customMetadata: metadata });
  const writer = writable.getWriter();
  for await (const part of download.content) {
    if (!(part instanceof Uint8Array)) throw new Error(`uid ${uid} streamed a non-binary chunk`);
    await writer.write(part);
  }
  await writer.close();
  await upload;
};

const dumpBatch = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
  mailbox: ServerMailbox,
  uids: readonly number[],
): Promise<string[]> => {
  const fetched = await client.fetchAll(
    uids.join(","),
    { uid: true, flags: true, internalDate: true, size: true },
    { uid: true },
  );
  const keys: string[] = [];
  for (const message of fetched.sort((left, right) => right.uid - left.uid)) {
    const key = messageKey(account.tenantId, account.accountId, mailbox.mailboxId, message.uid);
    const size = message.size ?? 0;
    const metadata = toCustomMetadata({
      uid: message.uid,
      sequenceNumber: message.seq,
      uidValidity: mailbox.uidValidity,
      internalDate: toEpoch(message.internalDate),
      rfc822Size: size,
      flags: [...(message.flags ?? [])],
    });
    await dumpMessage(env, client, key, metadata, message.uid, size);
    keys.push(key);
  }
  return keys;
};

const resetIfInvalidated = async (
  env: Env,
  account: MailAccount,
  mailbox: ServerMailbox,
  stored: MailboxView | undefined,
): Promise<boolean> => {
  if (stored === undefined || stored.uidValidity === mailbox.uidValidity) return false;
  const result = await tenantMail(env, account.tenantId).resetMailbox(account, mailbox.mailboxId);
  if (!result.ok) throw new Error(`reset ${mailbox.entry.path}: ${result.reason}`);
  await tenantSearch(env, account.tenantId).removeMessages(account, result.value);
  return true;
};

const newUids = async (client: ImapFlow, lastSyncUid: number): Promise<readonly number[]> => {
  const found = await client.search({ uid: `${lastSyncUid + 1}:*` }, { uid: true });
  if (found === false || found === undefined) return [];
  return found
    .filter((uid) => uid > lastSyncUid)
    .sort((left, right) => right - left)
    .slice(0, MAILBOX_LIMIT);
};

const recordCursor = async (
  env: Env,
  account: MailAccount,
  mailbox: ServerMailbox,
  highest: number | undefined,
): Promise<void> => {
  if (highest === undefined) return;
  const cursor = await tenantMail(env, account.tenantId).setMailboxCursor(
    account,
    mailbox.mailboxId,
    highest,
  );
  if (!cursor.ok) throw new Error(`cursor ${mailbox.entry.path}: ${cursor.reason}`);
};

export const syncMailbox = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
  mailbox: ServerMailbox,
  stored: MailboxView | undefined,
  onBatch: BatchQueued,
): Promise<MailboxSyncResult> => {
  const started = Date.now();
  const reset = await resetIfInvalidated(env, account, mailbox, stored);
  const lastSyncUid = reset ? 0 : (stored?.lastSyncUid ?? 0);
  const uidNext = mailbox.entry.status?.uidNext ?? 0;
  const base = { mailboxId: mailbox.mailboxId, path: mailbox.entry.path, reset };
  if (uidNext !== 0 && uidNext - 1 <= lastSyncUid) return { ...base, dumped: 0, batches: 0 };
  const lock = await client.getMailboxLock(mailbox.entry.path, { readOnly: true });
  try {
    const uids = await newUids(client, lastSyncUid);
    const batches = chunk(uids, BATCH_SIZE);
    for (const batch of batches) {
      const keys = await dumpBatch(env, client, account, mailbox, batch);
      await env.SYNC.send({
        kind: "ProcessBatch",
        tenantId: account.tenantId,
        accountId: account.accountId,
        accountConfigId: account.accountConfigId,
        mailboxId: mailbox.mailboxId,
        uidValidity: mailbox.uidValidity,
        keys,
      });
      await onBatch(keys.length);
    }
    await recordCursor(env, account, mailbox, uids[0]);
    const result = { ...base, dumped: uids.length, batches: batches.length };
    log.info("mailbox synced", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      ...result,
      durationMs: Date.now() - started,
    });
    return result;
  } finally {
    lock.release();
  }
};
