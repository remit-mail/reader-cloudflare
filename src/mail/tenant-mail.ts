import { DurableObject } from "cloudflare:workers";
import type { AddressFlags } from "@remit/api-openapi-types";
import type {
  AddressItem,
  CreateAddressInput,
  MailboxItem,
  ResultList,
  ThreadMessageItem,
} from "@remit/data-ports";
import { BadRequestError } from "@remit/data-ports/errors";
import { deriveAddressId, deriveBodyPartId, deriveEnvelopeId } from "@remit/data-ports/id";
import { syncStore } from "@remit/drizzle-service";
import { drizzle } from "drizzle-orm/durable-sqlite";
import migrations from "../../migrations/mail/migrations";
import { migrateDurableObject } from "../db/durable-migrate";
import type { Env } from "../env";
import { log } from "../log";
import { type AddressFlagsPatch, mergeAddressFlags, storedFlags } from "./address-flags";
import { deriveMessageId } from "./ids";
import { rekeyMail } from "./rekey";
import { composeMailRepositories, type MailRepositories } from "./repositories";
import type {
  AddressInput,
  AddressPage,
  AddressRole,
  AddressUpdate,
  FlagChange,
  FlagState,
  ImportedAddress,
  MailAccount,
  MailboxInput,
  MailboxRow,
  MailResult,
  MessageInput,
  MessageLocation,
  MessageRecord,
  NewOutbox,
  OutboxDraft,
  OutboxRecord,
  OutboxStateChange,
  SkippedMessage,
  SortOrder,
  ThreadPage,
  ThreadRow,
  ThreadSearch,
} from "./types";

const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";
const NO_PARENT = "";
const THREAD_LIMIT = 500;

type Sighting = "junk" | "discarded" | "correspondent";

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

const orUndefined = (value: string | null): string | undefined => value ?? undefined;

const roles = (input: MessageInput): readonly [AddressRole, readonly AddressInput[]][] => [
  ["from", input.envelope.from],
  ["sender", input.envelope.sender],
  ["reply_to", input.envelope.replyTo],
  ["to", input.envelope.to],
  ["cc", input.envelope.cc],
  ["bcc", input.envelope.bcc],
];

const sightingIn = (mailbox: MailboxItem): Sighting => {
  const uses = mailbox.specialUse ?? [];
  if (uses.includes("Junk")) return "junk";
  if (uses.includes("Trash")) return "discarded";
  return "correspondent";
};

const flagsOf = (address: AddressItem): AddressFlags =>
  storedFlags(address.flags ?? {}, address.addressId);

const starOf = (starred: boolean) => (starred ? ("yellow" as const) : ("none" as const));

const draftColumns = (draft: OutboxDraft) => ({
  toAddresses: [...draft.toAddresses],
  ccAddresses: [...draft.ccAddresses],
  bccAddresses: [...draft.bccAddresses],
  subject: orUndefined(draft.subject),
  textBody: orUndefined(draft.textBody),
  htmlBody: orUndefined(draft.htmlBody),
  inReplyTo: orUndefined(draft.inReplyTo),
  references: [...draft.references],
});

type PageRead =
  | { readonly ok: true; readonly result: ResultList<ThreadMessageItem> }
  | { readonly ok: false; readonly reason: string };

const invalidToken = (error: unknown): PageRead => {
  if (error instanceof BadRequestError) return { ok: false, reason: error.message };
  throw error;
};

export class TenantMail extends DurableObject<Env> {
  private readonly mail: MailRepositories;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    this.mail = composeMailRepositories(syncStore(db));
    void ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObject(db, migrations);
      await rekeyMail(ctx.storage, db, this.mail.searchIndex, ctx.id.toString());
    });
  }

  async upsertMailboxes(
    account: MailAccount,
    input: readonly MailboxInput[],
  ): Promise<readonly { readonly mailboxId: string; readonly path: string }[]> {
    const { mailbox } = this.mail;
    const stored: { mailboxId: string; path: string }[] = [];
    for (const entry of input) {
      const parent = parentPath(entry.path, entry.delimiter);
      const parentRow =
        parent === null ? null : await mailbox.findByPath(account.accountId, parent);
      const counters = {
        hierarchyDelimiter: entry.delimiter,
        namespacePrefix: entry.namespacePrefix,
        uidValidity: entry.uidValidity,
        uidNext: entry.uidNext,
        highestModseq: entry.highestModseq,
        messageCount: entry.messageCount,
        unseenCount: entry.unseenCount,
        parentMailboxId: parentRow?.mailboxId ?? NO_PARENT,
        specialUse: [...entry.specialUse],
      };
      const existing = await mailbox.findByPath(account.accountId, entry.path);
      const row =
        existing === null
          ? await mailbox.getOrCreateByPath(account.accountId, entry.path, {
              ...counters,
              deletedCount: 0,
              totalSize: 0,
              lastSyncUid: 0,
              highWaterMarkUid: 0,
              lastMessageSyncAt: 0,
            })
          : await mailbox.update(account.accountId, existing.mailboxId, counters);
      stored.push({ mailboxId: row.mailboxId, path: entry.path });
    }
    log.info("mailboxes upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      count: stored.length,
    });
    return stored;
  }

  async upsertMessages(
    account: MailAccount,
    mailboxId: string,
    input: readonly MessageInput[],
  ): Promise<MailResult<readonly { readonly messageId: string; readonly uid: number }[]>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) {
      log.warn("mailbox not found", {
        tenantId: account.tenantId,
        accountId: account.accountId,
        mailboxId,
      });
      return { ok: false, reason: "mailbox not found" };
    }
    const stored: { messageId: string; uid: number }[] = [];
    for (const message of input) {
      stored.push({
        messageId: await this.saveMessage(account, mailbox, message),
        uid: message.uid,
      });
    }
    log.info("messages upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      count: stored.length,
    });
    return { ok: true, value: stored };
  }

  async recordMailboxPass(
    account: MailAccount,
    mailboxId: string,
    lastSyncUid: number,
  ): Promise<MailResult<number>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    await this.mail.mailbox.update(account.accountId, mailboxId, {
      lastSyncUid,
      highWaterMarkUid: lastSyncUid,
      lastMessageSyncAt: Date.now(),
    });
    return { ok: true, value: lastSyncUid };
  }

  async lowestStoredUid(account: MailAccount, mailboxId: string): Promise<number> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return 0;
    const page = await this.mail.message.listByMailbox(mailboxId, { limit: 1 });
    return page.items[0]?.uid ?? 0;
  }

  async recordSkippedMessages(
    account: MailAccount,
    mailboxId: string,
    uidValidity: number,
    skipped: readonly SkippedMessage[],
  ): Promise<MailResult<number>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    await this.mail.syncWarning.recordFailures(
      skipped.map((skip) => ({
        accountConfigId: account.accountConfigId,
        accountId: account.accountId,
        mailboxId,
        uidValidity,
        uid: skip.uid,
        stage: "Body" as const,
      })),
    );
    const total = (await this.mail.syncWarning.listByMailboxId(mailboxId)).length;
    log.warn("messages skipped", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      skipped: skipped.length,
      total,
    });
    return { ok: true, value: total };
  }

  async resetMailbox(account: MailAccount, mailboxId: string): Promise<MailResult<number>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    const messages = await this.mail.message.listAllByMailbox(mailboxId);
    const messageIds = messages.map((message) => message.messageId);
    const threads = (
      await Promise.all(
        messageIds.map((messageId) =>
          this.mail.threadMessage.findAllByMessageId(account.accountConfigId, messageId),
        ),
      )
    ).flat();
    await this.mail.threadMessage.deleteMany(
      threads.map((thread) => ({
        accountConfigId: thread.accountConfigId,
        threadMessageId: thread.threadMessageId,
      })),
    );
    await this.mail.message.deleteMany(messageIds);
    await this.mail.mailbox.update(account.accountId, mailboxId, {
      lastSyncUid: 0,
      highWaterMarkUid: 0,
    });
    log.info("mailbox reset", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      removed: messageIds.length,
    });
    return { ok: true, value: messageIds.length };
  }

  async listMailboxes(accounts: readonly MailAccount[]): Promise<readonly MailboxRow[]> {
    const rows: MailboxRow[] = [];
    for (const account of accounts) {
      const mailboxes = await this.mail.mailbox.listAllByAccount(account.accountId);
      for (const mailbox of mailboxes.sort((left, right) =>
        left.fullPath.localeCompare(right.fullPath),
      )) {
        const storedMessages = await this.mail.threadMessage.countByMailbox(
          account.accountConfigId,
          mailbox.mailboxId,
          {},
          { excludeDeleted: true },
        );
        rows.push({ ...mailbox, storedMessages });
      }
    }
    return rows;
  }

  async listMailboxItems(accountIds: readonly string[]): Promise<readonly MailboxItem[]> {
    const lists = await Promise.all(
      accountIds.map((accountId) => this.mail.mailbox.listAllByAccount(accountId)),
    );
    return lists.flat();
  }

  async findMailbox(mailboxId: string): Promise<MailboxItem | null> {
    const accountId = await this.mail.mailbox.resolveAccountId(mailboxId);
    if (accountId === null) return null;
    const [mailbox] = await this.mail.mailbox.get(accountId, [mailboxId]);
    return mailbox ?? null;
  }

  async searchThreads(query: ThreadSearch): Promise<MailResult<ThreadPage>> {
    if (query.mailboxIds?.length === 0) {
      return {
        ok: true,
        value: { rows: query.results ? [] : null, continuationToken: null, count: 0 },
      };
    }
    const mailboxIds = query.mailboxIds === null ? undefined : new Set(query.mailboxIds);
    const scope = { ...(mailboxIds === undefined ? {} : { mailboxIds }), excludeDeleted: true };
    const page = query.results
      ? await this.mail.threadMessage
          .searchByDate(query.accountConfigId, query.search, {
            ...scope,
            order: query.order,
            limit: query.limit,
            ...(query.continuationToken === null
              ? {}
              : { continuationToken: query.continuationToken }),
          })
          .then((result): PageRead => ({ ok: true, result }), invalidToken)
      : null;
    if (page !== null && !page.ok) return page;
    const count = query.count
      ? await this.mail.threadMessage.countThreadsInScope(
          query.accountConfigId,
          query.search,
          scope,
        )
      : null;
    return {
      ok: true,
      value: {
        rows:
          page === null
            ? null
            : await this.withSenderFlags(query.accountConfigId, page.result.items),
        continuationToken: page?.result.continuationToken ?? null,
        count,
      },
    };
  }

  async listThreadMessages(
    accountConfigId: string,
    threadId: string,
    order: SortOrder,
  ): Promise<readonly ThreadRow[]> {
    const page = await this.mail.threadMessage.listByThread(threadId, accountConfigId, {
      order,
      limit: THREAD_LIMIT,
      excludeDeleted: true,
    });
    return this.withSenderFlags(accountConfigId, page.items);
  }

  async describeMessage(accountConfigId: string, messageId: string): Promise<MessageRecord | null> {
    const [message] = await this.mail.message.get([messageId]);
    if (message === undefined) return null;
    const accountId = await this.mail.mailbox.resolveAccountId(message.mailboxId);
    if (accountId === null) return null;
    const [mailbox] = await this.mail.mailbox.get(accountId, [message.mailboxId]);
    if (mailbox === undefined) return null;
    const description = await this.mail.message.describe(messageId);
    const [envelope] = description.envelope;
    if (envelope === undefined) throw new Error(`message ${messageId} has no envelope`);
    const addressIds = [...new Set(description.envelopeAddress.map((entry) => entry.addressId))];
    const flags = new Map(
      (await this.mail.address.getAddress(accountConfigId, addressIds)).map((address) => [
        address.addressId,
        flagsOf(address),
      ]),
    );
    const addresses = [...description.envelopeAddress]
      .sort(
        (left, right) =>
          left.addressRole.localeCompare(right.addressRole) ||
          left.addressOrder - right.addressOrder,
      )
      .map((entry) => ({
        addressId: entry.addressId,
        role: entry.addressRole,
        order: entry.addressOrder,
        displayName: entry.displayName ?? null,
        email: entry.normalizedEmail,
        flags: flags.get(entry.addressId) ?? {},
      }));
    return {
      message,
      accountId,
      mailboxPath: mailbox.fullPath,
      date: envelope.dateValue,
      subject: envelope.subject ?? null,
      messageIdValue: envelope.messageIdValue ?? null,
      addresses,
      flags: description.messageFlag.map((flag) => flag.flagName).sort(),
    };
  }

  async locateMessages(messageIds: readonly string[]): Promise<readonly MessageLocation[]> {
    const messages = await this.mail.message.get([...messageIds]);
    const locations: MessageLocation[] = [];
    for (const message of messages) {
      const mailbox = await this.findMailbox(message.mailboxId);
      if (mailbox === null) continue;
      locations.push({
        messageId: message.messageId,
        accountId: mailbox.accountId,
        mailboxId: mailbox.mailboxId,
        mailboxPath: mailbox.fullPath,
        uid: message.uid,
      });
    }
    return locations;
  }

  async setFlags(
    accountConfigId: string,
    messageIds: readonly string[],
    change: FlagChange,
  ): Promise<number> {
    for (const messageId of messageIds) {
      await this.applyFlag(messageId, SEEN, change.isRead);
      await this.applyFlag(messageId, FLAGGED, change.isStarred);
      const threads = await this.mail.threadMessage.findAllByMessageId(accountConfigId, messageId);
      for (const thread of threads) {
        await this.mail.threadMessage.update(accountConfigId, thread.threadMessageId, {
          ...(change.isRead === null ? {} : { isRead: change.isRead }),
          ...(change.isStarred === null
            ? {}
            : { hasStars: change.isStarred, star: starOf(change.isStarred) }),
        });
      }
    }
    log.info("flags set", { count: messageIds.length, ...change });
    return messageIds.length;
  }

  async flagState(accountConfigId: string, messageId: string): Promise<FlagState | null> {
    const thread = await this.mail.threadMessage.findByMessageId(accountConfigId, messageId);
    if (thread === null) return null;
    return { messageId, isRead: thread.isRead, isStarred: thread.hasStars };
  }

  async updateAddressFlags(
    accountConfigId: string,
    addressId: string,
    patch: AddressFlagsPatch,
  ): Promise<AddressUpdate> {
    const [current] = await this.mail.address.getAddress(accountConfigId, [addressId]);
    if (current === undefined) return { kind: "NotFound" };
    const merged = mergeAddressFlags(flagsOf(current), patch);
    if (!merged.ok) return { kind: "Invalid", reason: merged.reason };
    const address = await this.mail.address.updateAddress(accountConfigId, addressId, {
      flags: merged.flags,
    });
    log.info("address flags set", { addressId, flags: Object.keys(merged.flags) });
    return { kind: "Updated", address };
  }

  async createOutbox(input: NewOutbox): Promise<OutboxRecord> {
    return this.mail.outboxMessage.create({
      accountId: input.accountId,
      accountConfigId: input.accountConfigId,
      fromAddress: input.fromAddress,
      messageIdValue: input.messageIdValue,
      ...draftColumns(input.draft),
      status: "draft",
    });
  }

  async getOutbox(accountConfigId: string, outboxMessageId: string): Promise<OutboxRecord | null> {
    const [record] = await this.mail.outboxMessage.get(accountConfigId, [outboxMessageId]);
    return record ?? null;
  }

  async listOutbox(accountIds: readonly string[]): Promise<readonly OutboxRecord[]> {
    const page = await this.mail.outboxMessage.listByAccounts([...accountIds], { limit: 500 });
    return page.items;
  }

  async updateOutboxDraft(
    accountConfigId: string,
    outboxMessageId: string,
    draft: OutboxDraft,
  ): Promise<MailResult<OutboxRecord>> {
    const update = draftColumns(draft);
    const updated =
      (await this.mail.outboxMessage.updateIfStatus(
        accountConfigId,
        outboxMessageId,
        "draft",
        update,
      )) ??
      (await this.mail.outboxMessage.updateIfStatus(
        accountConfigId,
        outboxMessageId,
        "failed",
        update,
      ));
    if (updated === null) return { ok: false, reason: "outbox message is not an editable draft" };
    return { ok: true, value: updated };
  }

  async claimOutbox(
    accountConfigId: string,
    outboxMessageId: string,
  ): Promise<MailResult<OutboxRecord>> {
    const claim = { status: "sending" as const, lastError: "" };
    const claimed =
      (await this.mail.outboxMessage.updateIfStatus(
        accountConfigId,
        outboxMessageId,
        "draft",
        claim,
      )) ??
      (await this.mail.outboxMessage.updateIfStatus(
        accountConfigId,
        outboxMessageId,
        "failed",
        claim,
      ));
    if (claimed === null) return { ok: false, reason: "outbox message is not ready to send" };
    return { ok: true, value: claimed };
  }

  async settleOutbox(
    accountConfigId: string,
    outboxMessageId: string,
    change: OutboxStateChange,
  ): Promise<OutboxRecord> {
    return this.mail.outboxMessage.update(accountConfigId, outboxMessageId, {
      status: change.status,
      lastError: change.lastError ?? "",
      ...(change.sentAt === null ? {} : { sentAt: change.sentAt }),
    });
  }

  async listConfigAddresses(
    accountConfigId: string,
    after: string | null,
    limit: number,
  ): Promise<AddressPage> {
    const page = await this.mail.address.listAllByAccountConfigPage({
      accountConfigId,
      limit,
      ...(after === null ? {} : { cursor: after }),
    });
    return { items: page.items, next: page.continuationToken ?? null };
  }

  async importAddressFlags(entries: readonly ImportedAddress[]): Promise<number> {
    for (const { flags: patch, displayName, ...address } of entries) {
      const input: CreateAddressInput = {
        ...address,
        ...(displayName === null ? {} : { displayName }),
      };
      const stored = await this.mail.address.upsertAddress(input);
      const merged = mergeAddressFlags(flagsOf(stored), { flags: patch, clearFlags: [] });
      if (!merged.ok) throw new Error(`address ${address.addressId}: ${merged.reason}`);
      await this.mail.address.updateAddress(address.accountConfigId, address.addressId, {
        flags: merged.flags,
      });
    }
    log.info("address flags imported", { addresses: entries.length });
    return entries.length;
  }

  private async applyFlag(messageId: string, flag: string, set: boolean | null): Promise<void> {
    if (set === null) return;
    if (set) {
      await this.mail.messageFlag.addFlag(messageId, flag);
      return;
    }
    await this.mail.messageFlag.removeFlag(messageId, flag);
  }

  private async saveMessage(
    account: MailAccount,
    mailbox: MailboxItem,
    input: MessageInput,
  ): Promise<string> {
    const { envelope } = input;
    const messageId = await deriveMessageId(account.accountId, mailbox.mailboxId, input.uid);
    const envelopeId = deriveEnvelopeId(messageId);
    await this.mail.envelope.upsertEnvelope({
      envelopeId,
      messageId,
      dateValue: envelope.date,
      dateRaw: envelope.dateRaw,
      ...(envelope.subject === null ? {} : { subject: envelope.subject }),
      ...(envelope.messageId === null ? {} : { messageIdValue: envelope.messageId }),
    });
    const from = await this.saveAddresses(account, mailbox, messageId, input);
    const { created } = await this.mail.message.upsertWithStatus({
      messageId,
      mailboxId: mailbox.mailboxId,
      uid: input.uid,
      sequenceNumber: input.sequenceNumber,
      rfc822Size: input.rfc822Size,
      internalDate: input.internalDate,
      envelopeId,
      rootBodyPartId: deriveBodyPartId(messageId, "0"),
      ...(input.bodyStorageKey === null ? {} : { bodyStorageKey: input.bodyStorageKey }),
    });
    if (!created && input.bodyStorageKey !== null) {
      await this.mail.message.update(messageId, { bodyStorageKey: input.bodyStorageKey });
    }
    await this.saveFlags(messageId, input.flags);
    await this.saveThread(account, mailbox, messageId, input, from);
    return messageId;
  }

  private async saveFlags(messageId: string, flags: readonly string[]): Promise<void> {
    const wanted = new Set(flags);
    const stored = new Set(
      (await this.mail.messageFlag.getFlags(messageId)).map((flag) => flag.flagName),
    );
    await this.mail.messageFlag.removeFlags(
      messageId,
      [...stored].filter((flag) => !wanted.has(flag)),
    );
    await this.mail.messageFlag.addFlags(
      messageId,
      [...wanted].filter((flag) => !stored.has(flag)),
    );
  }

  private async saveAddresses(
    account: MailAccount,
    mailbox: MailboxItem,
    messageId: string,
    input: MessageInput,
  ): Promise<{ email: string; name: string } | null> {
    const sighting = sightingIn(mailbox);
    let from: { email: string; name: string } | null = null;
    for (const [role, list] of roles(input)) {
      for (const [order, entry] of list.entries()) {
        const parts = splitAddress(entry.address);
        if (parts === null) continue;
        const normalizedEmail = entry.address.toLowerCase();
        const displayName = entry.name ?? "";
        const address: CreateAddressInput = {
          addressId: deriveAddressId(account.accountConfigId, normalizedEmail),
          accountConfigId: account.accountConfigId,
          localPart: parts.localPart,
          domain: parts.domain,
          normalizedEmail,
          normalizedCompound: `${displayName.toLowerCase()} ${normalizedEmail}`.trim(),
          displayName,
        };
        if (sighting === "junk") await this.mail.address.upsertJunkAddress(address);
        if (sighting === "discarded") await this.mail.address.upsertAddress(address);
        if (sighting === "correspondent") {
          await this.mail.address.upsertCorrespondentAddress(address);
        }
        await this.mail.address.upsertEnvelopeAddress({
          messageId,
          addressId: address.addressId,
          displayName,
          normalizedEmail,
          addressRole: role,
          addressOrder: order,
        });
        if (role === "from" && from === null) from = { email: normalizedEmail, name: displayName };
      }
    }
    return from;
  }

  private async saveThread(
    account: MailAccount,
    mailbox: MailboxItem,
    messageId: string,
    input: MessageInput,
    from: { email: string; name: string } | null,
  ): Promise<void> {
    const { envelope } = input;
    const flags = new Set(input.flags);
    const starred = flags.has(FLAGGED);
    const summary = {
      mailboxId: mailbox.mailboxId,
      uid: input.uid,
      internalDate: input.internalDate,
      sentDate: envelope.date,
      isRead: flags.has(SEEN),
      hasAttachment: input.hasAttachment,
      hasStars: starred,
      star: starOf(starred),
      ...(envelope.subject === null ? {} : { subject: envelope.subject }),
      ...(envelope.messageId === null ? {} : { messageIdHeader: envelope.messageId }),
      ...(envelope.inReplyTo === null ? {} : { inReplyTo: envelope.inReplyTo }),
      ...(from === null ? {} : { fromEmail: from.email }),
      ...(from === null || from.name === "" ? {} : { fromName: from.name }),
      ...(input.snippet === null ? {} : { snippet: input.snippet }),
    };
    const existing = await this.mail.threadMessage.findByMessageId(
      account.accountConfigId,
      messageId,
    );
    if (existing !== null) {
      await this.mail.threadMessage.update(
        account.accountConfigId,
        existing.threadMessageId,
        summary,
      );
      return;
    }
    await this.mail.threadMessage.create({
      ...summary,
      threadId: messageId,
      messageId,
      accountConfigId: account.accountConfigId,
      referenceOrder: 0,
      isDeleted: false,
    });
  }

  private async withSenderFlags(
    accountConfigId: string,
    rows: readonly ThreadMessageItem[],
  ): Promise<ThreadRow[]> {
    const addressIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.fromEmail === undefined ? [] : [deriveAddressId(accountConfigId, row.fromEmail)],
        ),
      ),
    ];
    const flags = new Map(
      (await this.mail.address.getAddress(accountConfigId, addressIds)).map((address) => [
        address.addressId,
        flagsOf(address),
      ]),
    );
    return rows.map((row) => ({
      ...row,
      senderFlags:
        (row.fromEmail === undefined
          ? undefined
          : flags.get(deriveAddressId(accountConfigId, row.fromEmail))) ?? {},
    }));
  }
}
