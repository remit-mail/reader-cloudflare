import { DurableObject } from "cloudflare:workers";
import { generateBase36Id } from "@remit/drizzle-sqlite-schema";
import { and, asc, count, desc, eq, gt, inArray, like, lt, or, type SQL } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../migrations/mail/migrations";
import { inList } from "../db/in-list";
import type { Env } from "../env";
import { log } from "../log";
import { type AddressFlagsPatch, mergeAddressFlags, storedFlags } from "./address-flags";
import {
  deriveAddressId,
  deriveEnvelopeAddressId,
  deriveEnvelopeId,
  deriveFlagId,
  deriveMailboxId,
  deriveMessageId,
  deriveSpecialUseId,
  deriveThreadMessageId,
} from "./ids";
import * as schema from "./schema";
import {
  addresses,
  envelopeAddresses,
  envelopes,
  mailboxes,
  mailboxSpecialUseEntries,
  messageFlags,
  messages,
  outboxMessages,
  threadMessages,
} from "./schema";
import type {
  AddressInput,
  AddressRecord,
  AddressRole,
  AddressRow,
  AddressUpdate,
  FlagChange,
  FlagState,
  MailAccount,
  MailboxInput,
  MailboxRow,
  MailboxView,
  MailResult,
  MessageInput,
  MessageLocation,
  MessageRecord,
  NewOutbox,
  OutboxDraft,
  OutboxRecord,
  OutboxStateChange,
  OutboxStatus,
  SortOrder,
  SpecialUse,
  ThreadCursor,
  ThreadMessageRow,
  ThreadPage,
  ThreadQuery,
  ThreadRow,
} from "./types";

type MailDb = DrizzleSqliteDODatabase<typeof schema>;

type Tx = Parameters<Parameters<MailDb["transaction"]>[0]>[0];

interface PreparedMailbox {
  readonly mailboxId: string;
  readonly parentMailboxId: string;
  readonly input: MailboxInput;
  readonly specialUse: readonly { readonly id: string; readonly specialUse: SpecialUse }[];
}

interface PreparedAddress {
  readonly addressId: string;
  readonly envelopeAddressId: string;
  readonly role: AddressRole;
  readonly order: number;
  readonly displayName: string | undefined;
  readonly localPart: string;
  readonly domain: string;
  readonly email: string;
}

interface PreparedMessage {
  readonly messageId: string;
  readonly envelopeId: string;
  readonly threadMessageId: string;
  readonly input: MessageInput;
  readonly flags: readonly { readonly id: string; readonly name: string }[];
  readonly addresses: readonly PreparedAddress[];
}

const NO_PARENT = "None";
const NO_BODY_PART = "None";
const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";

const parentPath = (path: string, delimiter: string): string | null => {
  if (delimiter === "") return null;
  const index = path.lastIndexOf(delimiter);
  if (index <= 0) return null;
  return path.slice(0, index);
};

const splitAddress = (address: string): { localPart: string; domain: string } | null => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
};

const orNull = (value: string | null | undefined): string | null => value ?? null;

const orUndefined = (value: string | null): string | undefined => value ?? undefined;

const roles = (input: MessageInput): readonly [AddressRole, readonly AddressInput[]][] => [
  ["from", input.envelope.from],
  ["sender", input.envelope.sender],
  ["reply_to", input.envelope.replyTo],
  ["to", input.envelope.to],
  ["cc", input.envelope.cc],
  ["bcc", input.envelope.bcc],
];

const prepareMailbox = async (accountId: string, input: MailboxInput): Promise<PreparedMailbox> => {
  const mailboxId = await deriveMailboxId(accountId, input.path);
  const parent = parentPath(input.path, input.delimiter);
  const parentMailboxId = parent === null ? NO_PARENT : await deriveMailboxId(accountId, parent);
  const specialUse = await Promise.all(
    input.specialUse.map(async (use) => ({
      id: await deriveSpecialUseId(mailboxId, use),
      specialUse: use,
    })),
  );
  return { mailboxId, parentMailboxId, input, specialUse };
};

const prepareAddresses = async (
  account: MailAccount,
  messageId: string,
  input: MessageInput,
): Promise<PreparedAddress[]> => {
  const entries = roles(input).flatMap(([role, list]) =>
    list.map((address, order) => ({ role, order, address })),
  );
  const prepared = await Promise.all(
    entries.map(async ({ role, order, address }) => {
      const parts = splitAddress(address.address);
      if (parts === null) return null;
      const email = address.address.toLowerCase();
      return {
        addressId: await deriveAddressId(account.accountConfigId, email),
        envelopeAddressId: await deriveEnvelopeAddressId(messageId, role, order),
        role,
        order,
        displayName: orUndefined(address.name),
        localPart: parts.localPart,
        domain: parts.domain,
        email,
      };
    }),
  );
  return prepared.filter((entry): entry is PreparedAddress => entry !== null);
};

const prepareMessage = async (
  account: MailAccount,
  mailboxId: string,
  input: MessageInput,
): Promise<PreparedMessage> => {
  const messageId = await deriveMessageId(account.accountId, mailboxId, input.uid);
  const flags = await Promise.all(
    [...new Set(input.flags)].map(async (name) => ({
      id: await deriveFlagId(messageId, name),
      name,
    })),
  );
  return {
    messageId,
    envelopeId: await deriveEnvelopeId(messageId),
    threadMessageId: await deriveThreadMessageId(messageId),
    input,
    flags,
    addresses: await prepareAddresses(account, messageId, input),
  };
};

const writeMailbox = (tx: Tx, accountId: string, mailbox: PreparedMailbox, now: number): void => {
  const { input } = mailbox;
  const counters = {
    hierarchyDelimiter: input.delimiter,
    namespacePrefix: input.namespacePrefix,
    uidValidity: input.uidValidity,
    uidNext: input.uidNext,
    highestModseq: input.highestModseq,
    messageCount: input.messageCount,
    unseenCount: input.unseenCount,
    parentMailboxId: mailbox.parentMailboxId,
    specialUse: input.specialUse,
    updatedAt: now,
  };
  tx.insert(mailboxes)
    .values({
      ...counters,
      mailboxId: mailbox.mailboxId,
      accountId,
      fullPath: input.path,
      deletedCount: 0,
      totalSize: 0,
      lastSyncUid: 0,
      highWaterMarkUid: 0,
      lastMessageSyncAt: 0,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: mailboxes.mailboxId, set: counters })
    .run();
  const keep = new Set(mailbox.specialUse.map((entry) => entry.id));
  const existing = tx
    .select({ id: mailboxSpecialUseEntries.mailboxSpecialUseId })
    .from(mailboxSpecialUseEntries)
    .where(eq(mailboxSpecialUseEntries.mailboxId, mailbox.mailboxId))
    .all();
  for (const { id } of existing) {
    if (keep.has(id)) continue;
    tx.delete(mailboxSpecialUseEntries)
      .where(eq(mailboxSpecialUseEntries.mailboxSpecialUseId, id))
      .run();
  }
  for (const entry of mailbox.specialUse) {
    tx.insert(mailboxSpecialUseEntries)
      .values({
        mailboxSpecialUseId: entry.id,
        mailboxId: mailbox.mailboxId,
        specialUse: entry.specialUse,
      })
      .onConflictDoNothing()
      .run();
  }
};

const writeFlags = (tx: Tx, message: PreparedMessage, now: number): void => {
  const keep = new Set(message.flags.map((flag) => flag.id));
  const existing = tx
    .select({ id: messageFlags.messageFlagId })
    .from(messageFlags)
    .where(eq(messageFlags.messageId, message.messageId))
    .all();
  for (const { id } of existing) {
    if (keep.has(id)) continue;
    tx.delete(messageFlags).where(eq(messageFlags.messageFlagId, id)).run();
  }
  for (const flag of message.flags) {
    tx.insert(messageFlags)
      .values({
        messageFlagId: flag.id,
        messageId: message.messageId,
        flagName: flag.name,
        setAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
};

const writeAddresses = (
  tx: Tx,
  account: MailAccount,
  message: PreparedMessage,
  now: number,
): void => {
  tx.delete(envelopeAddresses).where(eq(envelopeAddresses.messageId, message.messageId)).run();
  for (const address of message.addresses) {
    const normalizedCompound =
      `${(address.displayName ?? "").toLowerCase()} ${address.email}`.trim();
    tx.insert(addresses)
      .values({
        addressId: address.addressId,
        accountConfigId: account.accountConfigId,
        displayName: address.displayName,
        localPart: address.localPart,
        domain: address.domain,
        normalizedEmail: address.email,
        normalizedCompound,
        flags: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    tx.insert(envelopeAddresses)
      .values({
        envelopeAddressId: address.envelopeAddressId,
        messageId: message.messageId,
        addressId: address.addressId,
        displayName: address.displayName,
        normalizedEmail: address.email,
        addressRole: address.role,
        addressOrder: address.order,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
};

const writeMessage = (
  tx: Tx,
  account: MailAccount,
  mailboxId: string,
  message: PreparedMessage,
  now: number,
): void => {
  const { input } = message;
  const { envelope } = input;
  const messageIdHeader = orUndefined(envelope.messageId);
  const subject = orUndefined(envelope.subject);
  const flagNames = new Set(input.flags);
  const isFlagged = flagNames.has(FLAGGED);
  const from = message.addresses.find((address) => address.role === "from");
  const imap = {
    sequenceNumber: input.sequenceNumber,
    rfc822Size: input.rfc822Size,
    internalDate: input.internalDate,
    messageIdHeader,
    updatedAt: now,
  };
  const body = input.bodyStorageKey === null ? {} : { bodyStorageKey: input.bodyStorageKey };
  tx.insert(messages)
    .values({
      ...imap,
      ...body,
      messageId: message.messageId,
      mailboxId,
      uid: input.uid,
      envelopeId: message.envelopeId,
      rootBodyPartId: NO_BODY_PART,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: messages.messageId, set: { ...imap, ...body } })
    .run();
  const envelopeRow = {
    dateValue: envelope.date,
    dateRaw: envelope.dateRaw,
    subject,
    messageIdValue: messageIdHeader,
    updatedAt: now,
  };
  tx.insert(envelopes)
    .values({
      ...envelopeRow,
      envelopeId: message.envelopeId,
      messageId: message.messageId,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: envelopes.envelopeId, set: envelopeRow })
    .run();
  writeFlags(tx, message, now);
  writeAddresses(tx, account, message, now);
  const summary = {
    messageIdHeader,
    inReplyTo: orUndefined(envelope.inReplyTo),
    fromEmail: from?.email,
    fromName: from?.displayName,
    subject,
    internalDate: input.internalDate,
    sentDate: envelope.date,
    isRead: flagNames.has(SEEN),
    hasAttachment: input.hasAttachment,
    star: isFlagged ? ("yellow" as const) : ("none" as const),
    hasStars: isFlagged,
    snippet: orUndefined(input.snippet),
    updatedAt: now,
  };
  tx.insert(threadMessages)
    .values({
      ...summary,
      threadMessageId: message.threadMessageId,
      threadId: message.messageId,
      messageId: message.messageId,
      accountConfigId: account.accountConfigId,
      mailboxId,
      uid: input.uid,
      referenceOrder: 0,
      isDeleted: false,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: threadMessages.threadMessageId, set: summary })
    .run();
};

const toAddressRecord = (row: AddressRow): AddressRecord => ({
  ...row,
  flags: storedFlags(row.flags, row.addressId),
});

const EDITABLE_OUTBOX: OutboxStatus[] = ["draft", "failed"];

type OutboxRow = typeof outboxMessages.$inferSelect;

const contains = (value: string): string => `%${value}%`;

const threadFilter = (query: ThreadQuery): SQL | undefined =>
  and(
    inList(threadMessages.mailboxId, query.mailboxIds),
    eq(threadMessages.isDeleted, false),
    query.messageIds === null ? undefined : inList(threadMessages.messageId, query.messageIds),
    query.unread === null ? undefined : eq(threadMessages.isRead, !query.unread),
    query.starred === null ? undefined : eq(threadMessages.hasStars, query.starred),
    query.attachments === null ? undefined : eq(threadMessages.hasAttachment, query.attachments),
    query.from === null
      ? undefined
      : or(
          like(threadMessages.fromEmail, contains(query.from)),
          like(threadMessages.fromName, contains(query.from)),
        ),
    query.subject === null ? undefined : like(threadMessages.subject, contains(query.subject)),
  );

const cursorFilter = (order: SortOrder, cursor: ThreadCursor | null): SQL | undefined => {
  if (cursor === null) return undefined;
  const past = order === "desc" ? lt : gt;
  return or(
    past(threadMessages.sentDate, cursor.sentDate),
    and(
      eq(threadMessages.sentDate, cursor.sentDate),
      past(threadMessages.messageId, cursor.messageId),
    ),
  );
};

const threadOrder = (order: SortOrder): [SQL, SQL] => {
  const direction = order === "desc" ? desc : asc;
  return [direction(threadMessages.sentDate), direction(threadMessages.messageId)];
};

const flagChanges = (change: FlagChange): { name: string; set: boolean }[] => [
  ...(change.isRead === null ? [] : [{ name: SEEN, set: change.isRead }]),
  ...(change.isStarred === null ? [] : [{ name: FLAGGED, set: change.isStarred }]),
];

const threadFlagUpdate = (change: FlagChange, now: number) => {
  if (change.isRead === null && change.isStarred === null) return null;
  return {
    updatedAt: now,
    ...(change.isRead === null ? {} : { isRead: change.isRead }),
    ...(change.isStarred === null
      ? {}
      : {
          hasStars: change.isStarred,
          star: change.isStarred ? ("yellow" as const) : ("none" as const),
        }),
  };
};

const outboxDraftColumns = (draft: OutboxDraft) => ({
  toAddresses: [...draft.toAddresses],
  ccAddresses: [...draft.ccAddresses],
  bccAddresses: [...draft.bccAddresses],
  subject: orUndefined(draft.subject),
  textBody: orUndefined(draft.textBody),
  htmlBody: orUndefined(draft.htmlBody),
  inReplyTo: orUndefined(draft.inReplyTo),
  references: [...draft.references],
});

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const stringList = (value: unknown, column: string): readonly string[] => {
  if (!isStringList(value)) throw new Error(`outbox column ${column} is not a string list`);
  return value;
};

const toOutboxRecord = (row: OutboxRow): OutboxRecord => ({
  outboxMessageId: row.outboxMessageId,
  accountId: row.accountId,
  accountConfigId: row.accountConfigId,
  fromAddress: row.fromAddress,
  fromName: orNull(row.fromName),
  toAddresses: stringList(row.toAddresses, "to_addresses"),
  ccAddresses: stringList(row.ccAddresses, "cc_addresses"),
  bccAddresses: stringList(row.bccAddresses, "bcc_addresses"),
  subject: orNull(row.subject),
  messageIdValue: row.messageIdValue,
  inReplyTo: orNull(row.inReplyTo),
  references: stringList(row.references, "references"),
  textBody: orNull(row.textBody),
  htmlBody: orNull(row.htmlBody),
  status: row.status,
  lastError: orNull(row.lastError),
  sentAt: row.sentAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class TenantMail extends DurableObject<Env> {
  private readonly db: MailDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  async upsertMailboxes(
    account: MailAccount,
    input: readonly MailboxInput[],
  ): Promise<readonly { readonly mailboxId: string; readonly path: string }[]> {
    const prepared = await Promise.all(
      input.map((mailbox) => prepareMailbox(account.accountId, mailbox)),
    );
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const mailbox of prepared) writeMailbox(tx, account.accountId, mailbox, now);
    });
    log.info("mailboxes upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      count: prepared.length,
    });
    return prepared.map((mailbox) => ({ mailboxId: mailbox.mailboxId, path: mailbox.input.path }));
  }

  async upsertMessages(
    account: MailAccount,
    mailboxId: string,
    input: readonly MessageInput[],
  ): Promise<MailResult<readonly { readonly messageId: string; readonly uid: number }[]>> {
    const prepared = await Promise.all(
      input.map((message) => prepareMessage(account, mailboxId, message)),
    );
    const now = Date.now();
    const found = this.db.transaction((tx) => {
      if (!this.ownsMailbox(tx, account.accountId, mailboxId)) return false;
      for (const message of prepared) writeMessage(tx, account, mailboxId, message, now);
      return true;
    });
    if (!found) {
      log.warn("mailbox not found", {
        tenantId: account.tenantId,
        accountId: account.accountId,
        mailboxId,
      });
      return { ok: false, reason: "mailbox not found" };
    }
    log.info("messages upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      count: prepared.length,
    });
    return {
      ok: true,
      value: prepared.map((message) => ({
        messageId: message.messageId,
        uid: message.input.uid,
      })),
    };
  }

  setMailboxCursor(
    account: MailAccount,
    mailboxId: string,
    lastSyncUid: number,
  ): MailResult<number> {
    const now = Date.now();
    const updated = this.db
      .update(mailboxes)
      .set({ lastSyncUid, highWaterMarkUid: lastSyncUid, lastMessageSyncAt: now, updatedAt: now })
      .where(and(eq(mailboxes.mailboxId, mailboxId), eq(mailboxes.accountId, account.accountId)))
      .returning({ mailboxId: mailboxes.mailboxId })
      .all();
    if (updated.length === 0) return { ok: false, reason: "mailbox not found" };
    log.info("mailbox cursor set", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      lastSyncUid,
    });
    return { ok: true, value: lastSyncUid };
  }

  resetMailbox(account: MailAccount, mailboxId: string): MailResult<readonly string[]> {
    const removed = this.db.transaction((tx) => {
      if (!this.ownsMailbox(tx, account.accountId, mailboxId)) return null;
      const owned = tx
        .select({ messageId: messages.messageId })
        .from(messages)
        .where(eq(messages.mailboxId, mailboxId));
      const messageIds = owned.all().map((row) => row.messageId);
      tx.delete(envelopeAddresses).where(inArray(envelopeAddresses.messageId, owned)).run();
      tx.delete(messageFlags).where(inArray(messageFlags.messageId, owned)).run();
      tx.delete(envelopes).where(inArray(envelopes.messageId, owned)).run();
      tx.delete(threadMessages).where(eq(threadMessages.mailboxId, mailboxId)).run();
      tx.delete(messages).where(eq(messages.mailboxId, mailboxId)).run();
      tx.update(mailboxes)
        .set({ lastSyncUid: 0, highWaterMarkUid: 0, updatedAt: Date.now() })
        .where(eq(mailboxes.mailboxId, mailboxId))
        .run();
      return messageIds;
    });
    if (removed === null) return { ok: false, reason: "mailbox not found" };
    log.info("mailbox reset", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      removed: removed.length,
    });
    return { ok: true, value: removed };
  }

  listMailboxes(account: MailAccount): readonly MailboxView[] {
    const rows = this.db
      .select({
        mailboxId: mailboxes.mailboxId,
        path: mailboxes.fullPath,
        delimiter: mailboxes.hierarchyDelimiter,
        parentMailboxId: mailboxes.parentMailboxId,
        uidValidity: mailboxes.uidValidity,
        uidNext: mailboxes.uidNext,
        messageCount: mailboxes.messageCount,
        unseenCount: mailboxes.unseenCount,
        lastSyncUid: mailboxes.lastSyncUid,
      })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.accountId))
      .orderBy(mailboxes.fullPath)
      .all();
    const uses = this.db
      .select({
        mailboxId: mailboxSpecialUseEntries.mailboxId,
        specialUse: mailboxSpecialUseEntries.specialUse,
      })
      .from(mailboxSpecialUseEntries)
      .innerJoin(mailboxes, eq(mailboxes.mailboxId, mailboxSpecialUseEntries.mailboxId))
      .where(eq(mailboxes.accountId, account.accountId))
      .all();
    const byMailbox = new Map<string, SpecialUse[]>();
    for (const use of uses) {
      byMailbox.set(use.mailboxId, [...(byMailbox.get(use.mailboxId) ?? []), use.specialUse]);
    }
    return rows.map((row) => ({ ...row, specialUse: byMailbox.get(row.mailboxId) ?? [] }));
  }

  listMailboxRows(accountIds: readonly string[]): readonly MailboxRow[] {
    if (accountIds.length === 0) return [];
    const rows = this.db
      .select({
        mailboxId: mailboxes.mailboxId,
        accountId: mailboxes.accountId,
        namespaceType: mailboxes.namespaceType,
        namespacePrefix: mailboxes.namespacePrefix,
        hierarchyDelimiter: mailboxes.hierarchyDelimiter,
        fullPath: mailboxes.fullPath,
        uidValidity: mailboxes.uidValidity,
        uidNext: mailboxes.uidNext,
        messageCount: mailboxes.messageCount,
        unseenCount: mailboxes.unseenCount,
        deletedCount: mailboxes.deletedCount,
        lastSyncUid: mailboxes.lastSyncUid,
        highWaterMarkUid: mailboxes.highWaterMarkUid,
        lastMessageSyncAt: mailboxes.lastMessageSyncAt,
        syncStatus: mailboxes.syncStatus,
        syncFailureReason: mailboxes.syncFailureReason,
        createdAt: mailboxes.createdAt,
        updatedAt: mailboxes.updatedAt,
      })
      .from(mailboxes)
      .where(inList(mailboxes.accountId, accountIds))
      .orderBy(mailboxes.accountId, mailboxes.fullPath)
      .all();
    const ids = rows.map((row) => row.mailboxId);
    const uses = this.specialUses(ids);
    const counts = new Map(
      this.db
        .select({ mailboxId: threadMessages.mailboxId, stored: count() })
        .from(threadMessages)
        .where(inList(threadMessages.mailboxId, ids))
        .groupBy(threadMessages.mailboxId)
        .all()
        .map((row) => [row.mailboxId, row.stored]),
    );
    return rows.map((row) => ({
      ...row,
      specialUse: uses.get(row.mailboxId) ?? [],
      storedMessages: counts.get(row.mailboxId) ?? 0,
    }));
  }

  findMailbox(mailboxId: string): MailboxRow | null {
    const row = this.db
      .select({ accountId: mailboxes.accountId })
      .from(mailboxes)
      .where(eq(mailboxes.mailboxId, mailboxId))
      .get();
    if (row === undefined) return null;
    return (
      this.listMailboxRows([row.accountId]).find((mailbox) => mailbox.mailboxId === mailboxId) ??
      null
    );
  }

  async listThreads(query: ThreadQuery): Promise<ThreadPage> {
    if (query.mailboxIds.length === 0) return { rows: [], next: null };
    const rows = this.db
      .select()
      .from(threadMessages)
      .where(and(threadFilter(query), cursorFilter(query.order, query.cursor)))
      .orderBy(...threadOrder(query.order))
      .limit(query.limit + 1)
      .all();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const next =
      rows.length > query.limit && last !== undefined
        ? { sentDate: last.sentDate, messageId: last.messageId }
        : null;
    return { rows: await this.withSenderFlags(page), next };
  }

  countThreads(query: ThreadQuery): number {
    if (query.mailboxIds.length === 0) return 0;
    const row = this.db
      .select({ total: count() })
      .from(threadMessages)
      .where(threadFilter(query))
      .get();
    return row?.total ?? 0;
  }

  async listThreadMessages(threadId: string, order: SortOrder): Promise<readonly ThreadRow[]> {
    const rows = this.db
      .select()
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, threadId), eq(threadMessages.isDeleted, false)))
      .orderBy(...threadOrder(order))
      .all();
    return this.withSenderFlags(rows);
  }

  describeMessage(messageId: string): MessageRecord | null {
    const row = this.db
      .select({
        messageId: messages.messageId,
        accountId: mailboxes.accountId,
        mailboxId: messages.mailboxId,
        mailboxPath: mailboxes.fullPath,
        uid: messages.uid,
        rfc822Size: messages.rfc822Size,
        internalDate: messages.internalDate,
        messageIdHeader: messages.messageIdHeader,
        bodyStorageKey: messages.bodyStorageKey,
        status: messages.status,
        syncStatus: messages.syncStatus,
        abandonedMutation: messages.abandonedMutation,
        date: envelopes.dateValue,
        subject: envelopes.subject,
        messageIdValue: envelopes.messageIdValue,
        category: threadMessages.category,
      })
      .from(messages)
      .innerJoin(mailboxes, eq(mailboxes.mailboxId, messages.mailboxId))
      .innerJoin(envelopes, eq(envelopes.envelopeId, messages.envelopeId))
      .innerJoin(threadMessages, eq(threadMessages.messageId, messages.messageId))
      .where(eq(messages.messageId, messageId))
      .get();
    if (row === undefined) return null;
    const addressRows = this.db
      .select({
        addressId: envelopeAddresses.addressId,
        role: envelopeAddresses.addressRole,
        order: envelopeAddresses.addressOrder,
        displayName: envelopeAddresses.displayName,
        email: envelopeAddresses.normalizedEmail,
        flags: addresses.flags,
      })
      .from(envelopeAddresses)
      .innerJoin(addresses, eq(addresses.addressId, envelopeAddresses.addressId))
      .where(eq(envelopeAddresses.messageId, messageId))
      .orderBy(envelopeAddresses.addressRole, envelopeAddresses.addressOrder)
      .all();
    const flags = this.db
      .select({ name: messageFlags.flagName })
      .from(messageFlags)
      .where(eq(messageFlags.messageId, messageId))
      .orderBy(messageFlags.flagName)
      .all();
    return {
      ...row,
      messageIdHeader: orNull(row.messageIdHeader),
      bodyStorageKey: orNull(row.bodyStorageKey),
      subject: orNull(row.subject),
      messageIdValue: orNull(row.messageIdValue),
      addresses: addressRows.map((address) => ({
        ...address,
        displayName: orNull(address.displayName),
        flags: storedFlags(address.flags, address.addressId),
      })),
      flags: flags.map((flag) => flag.name),
    };
  }

  locateMessages(messageIds: readonly string[]): readonly MessageLocation[] {
    if (messageIds.length === 0) return [];
    return this.db
      .select({
        messageId: messages.messageId,
        accountId: mailboxes.accountId,
        mailboxId: messages.mailboxId,
        mailboxPath: mailboxes.fullPath,
        uid: messages.uid,
      })
      .from(messages)
      .innerJoin(mailboxes, eq(mailboxes.mailboxId, messages.mailboxId))
      .where(inList(messages.messageId, messageIds))
      .all();
  }

  async setFlags(messageIds: readonly string[], change: FlagChange): Promise<number> {
    const now = Date.now();
    const changes = flagChanges(change);
    const prepared = await Promise.all(
      messageIds.flatMap((messageId) =>
        changes.map(async (flag) => ({
          ...flag,
          messageId,
          messageFlagId: await deriveFlagId(messageId, flag.name),
        })),
      ),
    );
    const summary = threadFlagUpdate(change, now);
    this.db.transaction((tx) => {
      if (summary !== null) {
        tx.update(threadMessages)
          .set(summary)
          .where(inList(threadMessages.messageId, messageIds))
          .run();
      }
      for (const flag of prepared) {
        if (!flag.set) {
          tx.delete(messageFlags).where(eq(messageFlags.messageFlagId, flag.messageFlagId)).run();
          continue;
        }
        tx.insert(messageFlags)
          .values({
            messageFlagId: flag.messageFlagId,
            messageId: flag.messageId,
            flagName: flag.name,
            setAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
      }
    });
    log.info("flags set", { count: messageIds.length, ...change });
    return messageIds.length;
  }

  flagState(messageId: string): FlagState | null {
    const row = this.db
      .select({
        messageId: threadMessages.messageId,
        isRead: threadMessages.isRead,
        isStarred: threadMessages.hasStars,
      })
      .from(threadMessages)
      .where(eq(threadMessages.messageId, messageId))
      .get();
    return row ?? null;
  }

  getAddress(addressId: string, accountConfigIds: readonly string[]): AddressRecord | null {
    if (accountConfigIds.length === 0) return null;
    const row = this.db
      .select()
      .from(addresses)
      .where(
        and(
          eq(addresses.addressId, addressId),
          inList(addresses.accountConfigId, accountConfigIds),
        ),
      )
      .get();
    return row === undefined ? null : toAddressRecord(row);
  }

  updateAddressFlags(
    addressId: string,
    accountConfigIds: readonly string[],
    patch: AddressFlagsPatch,
  ): AddressUpdate {
    const current = this.getAddress(addressId, accountConfigIds);
    if (current === null) return { kind: "NotFound" };
    const merged = mergeAddressFlags(current.flags, patch);
    if (!merged.ok) return { kind: "Invalid", reason: merged.reason };
    const row = this.db
      .update(addresses)
      .set({ flags: merged.flags, updatedAt: Date.now() })
      .where(eq(addresses.addressId, addressId))
      .returning()
      .get();
    if (row === undefined) throw new Error(`address ${addressId} vanished during a flag update`);
    log.info("address flags set", { addressId, flags: Object.keys(merged.flags) });
    return { kind: "Updated", address: toAddressRecord(row) };
  }

  createOutbox(input: NewOutbox): OutboxRecord {
    const now = Date.now();
    const row = this.db
      .insert(outboxMessages)
      .values({
        outboxMessageId: generateBase36Id(),
        accountId: input.accountId,
        accountConfigId: input.accountConfigId,
        fromAddress: input.fromAddress,
        messageIdValue: input.messageIdValue,
        ...outboxDraftColumns(input.draft),
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toOutboxRecord(row);
  }

  getOutbox(outboxMessageId: string): OutboxRecord | null {
    const row = this.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.outboxMessageId, outboxMessageId))
      .get();
    return row === undefined ? null : toOutboxRecord(row);
  }

  listOutbox(accountIds: readonly string[]): readonly OutboxRecord[] {
    if (accountIds.length === 0) return [];
    return this.db
      .select()
      .from(outboxMessages)
      .where(inList(outboxMessages.accountId, accountIds))
      .orderBy(desc(outboxMessages.createdAt))
      .all()
      .map(toOutboxRecord);
  }

  updateOutboxDraft(outboxMessageId: string, draft: OutboxDraft): MailResult<OutboxRecord> {
    const row = this.db
      .update(outboxMessages)
      .set({ ...outboxDraftColumns(draft), updatedAt: Date.now() })
      .where(
        and(
          eq(outboxMessages.outboxMessageId, outboxMessageId),
          inArray(outboxMessages.status, EDITABLE_OUTBOX),
        ),
      )
      .returning()
      .get();
    if (row === undefined) return { ok: false, reason: "outbox message is not an editable draft" };
    return { ok: true, value: toOutboxRecord(row) };
  }

  claimOutbox(outboxMessageId: string): MailResult<OutboxRecord> {
    const row = this.db
      .update(outboxMessages)
      .set({ status: "sending", lastError: null, updatedAt: Date.now() })
      .where(
        and(
          eq(outboxMessages.outboxMessageId, outboxMessageId),
          inArray(outboxMessages.status, EDITABLE_OUTBOX),
        ),
      )
      .returning()
      .get();
    if (row === undefined) return { ok: false, reason: "outbox message is not ready to send" };
    return { ok: true, value: toOutboxRecord(row) };
  }

  settleOutbox(outboxMessageId: string, change: OutboxStateChange): OutboxRecord {
    const row = this.db
      .update(outboxMessages)
      .set({
        status: change.status,
        lastError: change.lastError,
        sentAt: change.sentAt,
        updatedAt: Date.now(),
      })
      .where(eq(outboxMessages.outboxMessageId, outboxMessageId))
      .returning()
      .get();
    if (row === undefined) throw new Error(`outbox message ${outboxMessageId} vanished`);
    return toOutboxRecord(row);
  }

  private async withSenderFlags(rows: readonly ThreadMessageRow[]): Promise<ThreadRow[]> {
    const keyed = await Promise.all(
      rows.map(async (row) => ({
        row,
        addressId:
          typeof row.fromEmail !== "string"
            ? null
            : await deriveAddressId(row.accountConfigId, row.fromEmail),
      })),
    );
    const ids = [
      ...new Set(keyed.flatMap((entry) => (entry.addressId === null ? [] : [entry.addressId]))),
    ];
    const flags = new Map(
      ids.length === 0
        ? []
        : this.db
            .select({ addressId: addresses.addressId, flags: addresses.flags })
            .from(addresses)
            .where(inList(addresses.addressId, ids))
            .all()
            .map((entry) => [entry.addressId, storedFlags(entry.flags, entry.addressId)]),
    );
    return keyed.map(({ row, addressId }) => ({
      ...row,
      senderFlags: (addressId === null ? undefined : flags.get(addressId)) ?? {},
    }));
  }

  private specialUses(mailboxIds: readonly string[]): Map<string, SpecialUse[]> {
    const uses = this.db
      .select({
        mailboxId: mailboxSpecialUseEntries.mailboxId,
        specialUse: mailboxSpecialUseEntries.specialUse,
      })
      .from(mailboxSpecialUseEntries)
      .where(inList(mailboxSpecialUseEntries.mailboxId, mailboxIds))
      .all();
    const byMailbox = new Map<string, SpecialUse[]>();
    for (const use of uses) {
      byMailbox.set(use.mailboxId, [...(byMailbox.get(use.mailboxId) ?? []), use.specialUse]);
    }
    return byMailbox;
  }

  private ownsMailbox(db: MailDb | Tx, accountId: string, mailboxId: string): boolean {
    const row = db
      .select({ mailboxId: mailboxes.mailboxId })
      .from(mailboxes)
      .where(and(eq(mailboxes.mailboxId, mailboxId), eq(mailboxes.accountId, accountId)))
      .get();
    return row !== undefined;
  }
}
