import type { MailboxItem } from "@remit/data-ports";
import { buildMessageBodyKey } from "@remit/storage-service";
import type {
  FetchMessageObject,
  ImapFlow,
  ListResponse,
  MessageAddressObject,
  MessageEnvelopeObject,
  MessageStructureObject,
} from "imapflow";
import type { Env } from "../env";
import { currentCorrelationId, log } from "../log";
import { deriveMessageId } from "../mail/ids";
import type {
  AddressInput,
  EnvelopeInput,
  MailAccount,
  MailboxInput,
  MessageInput,
  SpecialUse,
  SyncedMessage,
} from "../mail/types";
import { tenantMail } from "../stubs";
import type { MailboxMark } from "./state";

const BATCH_SIZE = 10;
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

const addressesOf = (list: readonly MessageAddressObject[] | undefined): AddressInput[] =>
  (list ?? []).flatMap((entry): AddressInput[] =>
    entry.address === undefined || entry.address === ""
      ? []
      : [
          {
            name: entry.name === undefined || entry.name === "" ? null : entry.name,
            address: entry.address,
          },
        ],
  );

const timeOf = (date: Date | string | undefined): number | null => {
  if (date === undefined) return null;
  const time = new Date(date).getTime();
  return Number.isNaN(time) ? null : time;
};

const toEnvelopeInput = (
  envelope: MessageEnvelopeObject | undefined,
  internalDate: number,
): EnvelopeInput => {
  const sent = timeOf(envelope?.date);
  return {
    date: sent ?? internalDate,
    dateRaw: sent === null ? "" : new Date(sent).toISOString(),
    subject: envelope?.subject ?? null,
    messageId: envelope?.messageId ?? null,
    inReplyTo: envelope?.inReplyTo ?? null,
    from: addressesOf(envelope?.from),
    sender: addressesOf(envelope?.sender),
    replyTo: addressesOf(envelope?.replyTo),
    to: addressesOf(envelope?.to),
    cc: addressesOf(envelope?.cc),
    bcc: addressesOf(envelope?.bcc),
  };
};

const carriesAttachment = (node: MessageStructureObject | undefined): boolean => {
  if (node === undefined) return false;
  const children = node.childNodes ?? [];
  if (children.length > 0) return children.some(carriesAttachment);
  return node.disposition === "attachment";
};

const toMessageInput = (
  messageId: string,
  message: FetchMessageObject,
  size: number,
): MessageInput => {
  const internalDate = toEpoch(message.internalDate);
  return {
    messageId,
    uid: message.uid,
    sequenceNumber: message.seq,
    rfc822Size: size,
    internalDate,
    envelope: toEnvelopeInput(message.envelope, internalDate),
    flags: [...(message.flags ?? [])],
    hasAttachment: carriesAttachment(message.bodyStructure),
  };
};

const dumpMessage = async (
  env: Env,
  client: ImapFlow,
  key: string,
  uid: number,
  size: number,
): Promise<void> => {
  const download = await client.download(String(uid), undefined, { uid: true });
  if (download.content === undefined) throw new Error(`uid ${uid} vanished during download`);
  const { readable, writable } = new FixedLengthStream(size);
  const upload = env.MAIL.put(key, readable);
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
): Promise<readonly SyncedMessage[]> => {
  const fetched = await client.fetchAll(
    uids.join(","),
    {
      uid: true,
      flags: true,
      internalDate: true,
      size: true,
      envelope: true,
      bodyStructure: true,
    },
    { uid: true },
  );
  const inputs: MessageInput[] = [];
  for (const message of fetched.sort((left, right) => right.uid - left.uid)) {
    const messageId = await deriveMessageId(account.accountId, mailbox.mailboxId, message.uid);
    const key = buildMessageBodyKey(account.accountConfigId, account.accountId, messageId);
    const size = message.size ?? 0;
    await dumpMessage(env, client, key, message.uid, size);
    inputs.push(toMessageInput(messageId, message, size));
  }
  const stored = await tenantMail(env, account.tenantId).upsertMessages(
    account,
    mailbox.mailboxId,
    inputs,
  );
  if (!stored.ok) throw new Error(`upsert ${mailbox.entry.path}: ${stored.reason}`);
  return stored.value;
};

const resetIfInvalidated = async (
  env: Env,
  account: MailAccount,
  mailbox: ServerMailbox,
  stored: MailboxItem | undefined,
): Promise<boolean> => {
  if (stored === undefined || stored.uidValidity === mailbox.uidValidity) return false;
  const result = await tenantMail(env, account.tenantId).resetMailbox(account, mailbox.mailboxId);
  if (!result.ok) throw new Error(`reset ${mailbox.entry.path}: ${result.reason}`);
  return true;
};

type WorkPhase = "Initial" | "NewMail" | "Backfill" | "Complete";

interface MailboxWork {
  readonly phase: WorkPhase;
  readonly uids: readonly number[];
  readonly cursor: number;
  readonly lowWaterMark: number;
  readonly remaining: number;
}

export interface MailboxPass {
  readonly mark: MailboxMark;
  readonly phase: WorkPhase;
  readonly dumped: number;
  readonly remaining: number;
}

const descending = (left: number, right: number): number => right - left;

const ascending = (left: number, right: number): number => left - right;

const searchUids = async (client: ImapFlow, range: string): Promise<number[]> => {
  const found = await client.search({ uid: range }, { uid: true });
  if (found === false || found === undefined) return [];
  return found;
};

const lowestOf = (uids: readonly number[], fallback: number): number =>
  uids.length === 0 ? fallback : Math.min(...uids);

const initialWork = async (client: ImapFlow): Promise<MailboxWork> => {
  const all = (await searchUids(client, "1:*")).sort(descending);
  const uids = all.slice(0, MAILBOX_LIMIT);
  const remaining = all.length - uids.length;
  return {
    phase: "Initial",
    uids,
    cursor: uids[0] ?? 0,
    lowWaterMark: remaining === 0 ? 1 : lowestOf(uids, 1),
    remaining,
  };
};

const planWork = async (
  client: ImapFlow,
  cursor: number,
  lowWaterMark: number,
): Promise<MailboxWork> => {
  if (cursor === 0) return initialWork(client);
  const above = (await searchUids(client, `${cursor + 1}:*`))
    .filter((uid) => uid > cursor)
    .sort(ascending);
  const below =
    lowWaterMark > 1
      ? (await searchUids(client, `1:${lowWaterMark - 1}`))
          .filter((uid) => uid < lowWaterMark)
          .sort(descending)
      : [];
  const settledLow = below.length === 0 ? 1 : lowWaterMark;
  if (above.length > 0) {
    const uids = above.slice(0, MAILBOX_LIMIT);
    return {
      phase: "NewMail",
      uids: [...uids].sort(descending),
      cursor: Math.max(...uids),
      lowWaterMark: settledLow,
      remaining: above.length - uids.length + below.length,
    };
  }
  const uids = below.slice(0, MAILBOX_LIMIT);
  const remaining = below.length - uids.length;
  return {
    phase: uids.length === 0 ? "Complete" : "Backfill",
    uids,
    cursor,
    lowWaterMark: remaining === 0 ? 1 : lowestOf(uids, settledLow),
    remaining,
  };
};

const startingLowWaterMark = async (
  env: Env,
  account: MailAccount,
  mailbox: ServerMailbox,
  cursor: number,
  mark: MailboxMark | undefined,
): Promise<number> => {
  if (mark !== undefined && mark.uidValidity === mailbox.uidValidity) return mark.lowWaterMark;
  if (cursor === 0) return 1;
  const lowest = await tenantMail(env, account.tenantId).lowestStoredUid(
    account,
    mailbox.mailboxId,
  );
  return lowest === 0 ? cursor + 1 : lowest;
};

const enqueueBatches = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
  mailbox: ServerMailbox,
  uids: readonly number[],
  onBatch: BatchQueued,
): Promise<void> => {
  for (const batch of chunk(uids, BATCH_SIZE)) {
    const messages = await dumpBatch(env, client, account, mailbox, batch);
    if (messages.length === 0) continue;
    await env.SYNC.send({
      kind: "ProcessBatch",
      tenantId: account.tenantId,
      accountId: account.accountId,
      accountConfigId: account.accountConfigId,
      mailboxId: mailbox.mailboxId,
      messages: [...messages],
      correlationId: currentCorrelationId(),
      redrive: false,
      split: false,
    });
    log.info("batch enqueued", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId: mailbox.mailboxId,
      messages: messages.length,
      firstUid: batch[0],
      lastUid: batch[batch.length - 1],
    });
    await onBatch(messages.length);
  }
};

const isUpToDate = (mailbox: ServerMailbox, cursor: number, lowWaterMark: number): boolean => {
  const uidNext = mailbox.entry.status?.uidNext ?? 0;
  return cursor > 0 && uidNext !== 0 && uidNext - 1 <= cursor && lowWaterMark <= 1;
};

const workFor = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
  mailbox: ServerMailbox,
  cursor: number,
  lowWaterMark: number,
  onBatch: BatchQueued,
): Promise<MailboxWork> => {
  if (isUpToDate(mailbox, cursor, lowWaterMark)) {
    return { phase: "Complete", uids: [], cursor, lowWaterMark, remaining: 0 };
  }
  const lock = await client.getMailboxLock(mailbox.entry.path, { readOnly: true });
  return planWork(client, cursor, lowWaterMark)
    .then(async (planned) => {
      await enqueueBatches(env, client, account, mailbox, planned.uids, onBatch);
      return planned;
    })
    .finally(() => lock.release());
};

export const syncMailbox = async (
  env: Env,
  client: ImapFlow,
  account: MailAccount,
  mailbox: ServerMailbox,
  stored: MailboxItem | undefined,
  mark: MailboxMark | undefined,
  onBatch: BatchQueued,
): Promise<MailboxPass> => {
  const started = Date.now();
  const reset = await resetIfInvalidated(env, account, mailbox, stored);
  const cursor = reset ? 0 : (stored?.lastSyncUid ?? 0);
  const lowWaterMark = await startingLowWaterMark(
    env,
    account,
    mailbox,
    cursor,
    reset ? undefined : mark,
  );
  const fields = {
    tenantId: account.tenantId,
    accountId: account.accountId,
    mailboxId: mailbox.mailboxId,
    path: mailbox.entry.path,
  };
  const work = await workFor(env, client, account, mailbox, cursor, lowWaterMark, onBatch);
  const recorded = await tenantMail(env, account.tenantId).recordMailboxPass(
    account,
    mailbox.mailboxId,
    work.cursor,
  );
  if (!recorded.ok) throw new Error(`pass ${mailbox.entry.path}: ${recorded.reason}`);
  if (work.remaining > 0) {
    log.warn("cap reached", {
      ...fields,
      phase: work.phase,
      cap: MAILBOX_LIMIT,
      remaining: work.remaining,
      lowWaterMark: work.lowWaterMark,
    });
  }
  log.info("mailbox synced", {
    ...fields,
    reset,
    phase: work.phase,
    dumped: work.uids.length,
    remaining: work.remaining,
    cursor: work.cursor,
    lowWaterMark: work.lowWaterMark,
    durationMs: Date.now() - started,
  });
  return {
    mark: {
      uidValidity: mailbox.uidValidity,
      lowWaterMark: work.lowWaterMark,
      remaining: work.remaining,
      checkedAt: Date.now(),
    },
    phase: work.phase,
    dumped: work.uids.length,
    remaining: work.remaining,
  };
};
