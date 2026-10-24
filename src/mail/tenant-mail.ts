import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../migrations/mail/migrations";
import type { Env } from "../env";
import { log } from "../log";
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
  threadMessages,
} from "./schema";
import type {
  AddressInput,
  AddressRole,
  MailAccount,
  MailboxInput,
  MailboxView,
  MailResult,
  MessageInput,
  MessagePage,
  MessageSummary,
  MessageView,
  SpecialUse,
} from "./types";

type MailDb = DrizzleSqliteDODatabase<typeof schema>;

type Tx = Parameters<Parameters<MailDb["transaction"]>[0]>[0];

export interface MessageCursor {
  readonly sentDate: number;
  readonly messageId: string;
}

export interface ListMessagesOptions {
  readonly limit: number;
  readonly before: MessageCursor | null;
}

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

  listMessages(
    account: MailAccount,
    mailboxId: string,
    options: ListMessagesOptions,
  ): MailResult<MessagePage> {
    if (!this.ownsMailbox(this.db, account.accountId, mailboxId)) {
      return { ok: false, reason: "mailbox not found" };
    }
    const { before } = options;
    const cursor =
      before === null
        ? undefined
        : or(
            lt(threadMessages.sentDate, before.sentDate),
            and(
              eq(threadMessages.sentDate, before.sentDate),
              lt(threadMessages.messageId, before.messageId),
            ),
          );
    const rows = this.db
      .select({
        messageId: threadMessages.messageId,
        threadId: threadMessages.threadId,
        uid: threadMessages.uid,
        subject: threadMessages.subject,
        fromName: threadMessages.fromName,
        fromEmail: threadMessages.fromEmail,
        sentDate: threadMessages.sentDate,
        internalDate: threadMessages.internalDate,
        isRead: threadMessages.isRead,
        isFlagged: threadMessages.hasStars,
        hasAttachment: threadMessages.hasAttachment,
        snippet: threadMessages.snippet,
      })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.accountConfigId, account.accountConfigId),
          eq(threadMessages.mailboxId, mailboxId),
          eq(threadMessages.isDeleted, false),
          cursor,
        ),
      )
      .orderBy(desc(threadMessages.sentDate), desc(threadMessages.messageId))
      .limit(options.limit + 1)
      .all();
    const page: MessageSummary[] = rows.slice(0, options.limit).map((row) => ({
      ...row,
      subject: orNull(row.subject),
      fromName: orNull(row.fromName),
      fromEmail: orNull(row.fromEmail),
      snippet: orNull(row.snippet),
    }));
    const last = page.at(-1);
    const nextBefore =
      rows.length > options.limit && last !== undefined
        ? `${last.sentDate}:${last.messageId}`
        : null;
    return { ok: true, value: { messages: page, nextBefore } };
  }

  getMessage(account: MailAccount, messageId: string): MailResult<MessageView> {
    const row = this.db
      .select({
        messageId: messages.messageId,
        mailboxId: messages.mailboxId,
        uid: messages.uid,
        rfc822Size: messages.rfc822Size,
        internalDate: messages.internalDate,
        messageIdHeader: messages.messageIdHeader,
        bodyStorageKey: messages.bodyStorageKey,
        date: envelopes.dateValue,
        dateRaw: envelopes.dateRaw,
        subject: envelopes.subject,
      })
      .from(messages)
      .innerJoin(mailboxes, eq(mailboxes.mailboxId, messages.mailboxId))
      .innerJoin(envelopes, eq(envelopes.envelopeId, messages.envelopeId))
      .where(and(eq(messages.messageId, messageId), eq(mailboxes.accountId, account.accountId)))
      .get();
    if (row === undefined) return { ok: false, reason: "message not found" };
    const addressRows = this.db
      .select({
        role: envelopeAddresses.addressRole,
        order: envelopeAddresses.addressOrder,
        name: envelopeAddresses.displayName,
        email: envelopeAddresses.normalizedEmail,
      })
      .from(envelopeAddresses)
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
      ok: true,
      value: {
        ...row,
        messageIdHeader: orNull(row.messageIdHeader),
        bodyStorageKey: orNull(row.bodyStorageKey),
        subject: orNull(row.subject),
        addresses: addressRows.map((address) => ({ ...address, name: orNull(address.name) })),
        flags: flags.map((flag) => flag.name),
      },
    };
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
