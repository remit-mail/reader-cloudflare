import type { AddressFlags } from "@remit/api-openapi-types";
import type { RemitClientCore } from "@remit/backend/create-remit-client";
import type { AddressItem } from "@remit/data-ports";
import { log } from "../log";
import { type AddressFlagsPatch, mergeAddressFlags, storedFlags } from "./address-flags";
import type {
  AddressUpdate,
  FlagChange,
  FlagState,
  MailResult,
  MessageLocation,
  MessageRecord,
  NewOutbox,
  OutboxDraft,
  OutboxRecord,
  OutboxStateChange,
} from "./types";

export type MailStore = Pick<
  RemitClientCore,
  "address" | "mailbox" | "message" | "messageFlag" | "outboxMessage" | "threadMessage"
>;

const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";

const flagsOf = (address: AddressItem): AddressFlags =>
  storedFlags(address.flags ?? {}, address.addressId);

export const starOf = (starred: boolean) => (starred ? ("yellow" as const) : ("none" as const));

const orUndefined = (value: string | null): string | undefined => value ?? undefined;

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

export const describeMessage = async (
  mail: MailStore,
  accountConfigId: string,
  messageId: string,
): Promise<MessageRecord | null> => {
  const [message] = await mail.message.get([messageId]);
  if (message === undefined) return null;
  const accountId = await mail.mailbox.resolveAccountId(message.mailboxId);
  if (accountId === null) return null;
  const [mailbox] = await mail.mailbox.get(accountId, [message.mailboxId]);
  if (mailbox === undefined) return null;
  const description = await mail.message.describe(messageId);
  const [envelope] = description.envelope;
  if (envelope === undefined) throw new Error(`message ${messageId} has no envelope`);
  const addressIds = [...new Set(description.envelopeAddress.map((entry) => entry.addressId))];
  const flags = new Map(
    (await mail.address.getAddress(accountConfigId, addressIds)).map((address) => [
      address.addressId,
      flagsOf(address),
    ]),
  );
  const addresses = [...description.envelopeAddress]
    .sort(
      (left, right) =>
        left.addressRole.localeCompare(right.addressRole) || left.addressOrder - right.addressOrder,
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
};

export const locateMessages = async (
  mail: MailStore,
  messageIds: readonly string[],
): Promise<readonly MessageLocation[]> => {
  const messages = await mail.message.get([...messageIds]);
  const locations: MessageLocation[] = [];
  for (const message of messages) {
    const accountId = await mail.mailbox.resolveAccountId(message.mailboxId);
    if (accountId === null) continue;
    const [mailbox] = await mail.mailbox.get(accountId, [message.mailboxId]);
    if (mailbox === undefined) continue;
    locations.push({
      messageId: message.messageId,
      accountId: mailbox.accountId,
      mailboxId: mailbox.mailboxId,
      mailboxPath: mailbox.fullPath,
      uid: message.uid,
    });
  }
  return locations;
};

const applyFlag = async (
  mail: MailStore,
  messageId: string,
  flag: string,
  set: boolean | null,
): Promise<void> => {
  if (set === null) return;
  if (set) {
    await mail.messageFlag.addFlag(messageId, flag);
    return;
  }
  await mail.messageFlag.removeFlag(messageId, flag);
};

export const setFlags = async (
  mail: MailStore,
  accountConfigId: string,
  messageIds: readonly string[],
  change: FlagChange,
): Promise<number> => {
  for (const messageId of messageIds) {
    await applyFlag(mail, messageId, SEEN, change.isRead);
    await applyFlag(mail, messageId, FLAGGED, change.isStarred);
    const threads = await mail.threadMessage.findAllByMessageId(accountConfigId, messageId);
    for (const thread of threads) {
      await mail.threadMessage.update(accountConfigId, thread.threadMessageId, {
        ...(change.isRead === null ? {} : { isRead: change.isRead }),
        ...(change.isStarred === null
          ? {}
          : { hasStars: change.isStarred, star: starOf(change.isStarred) }),
      });
    }
  }
  log.info("flags set", { count: messageIds.length, ...change });
  return messageIds.length;
};

export const flagState = async (
  mail: MailStore,
  accountConfigId: string,
  messageId: string,
): Promise<FlagState | null> => {
  const thread = await mail.threadMessage.findByMessageId(accountConfigId, messageId);
  if (thread === null) return null;
  return { messageId, isRead: thread.isRead, isStarred: thread.hasStars };
};

export const updateAddressFlags = async (
  mail: MailStore,
  accountConfigId: string,
  addressId: string,
  patch: AddressFlagsPatch,
): Promise<AddressUpdate> => {
  const [current] = await mail.address.getAddress(accountConfigId, [addressId]);
  if (current === undefined) return { kind: "NotFound" };
  const merged = mergeAddressFlags(flagsOf(current), patch);
  if (!merged.ok) return { kind: "Invalid", reason: merged.reason };
  const address = await mail.address.updateAddress(accountConfigId, addressId, {
    flags: merged.flags,
  });
  log.info("address flags set", { addressId, flags: Object.keys(merged.flags) });
  return { kind: "Updated", address };
};

export const createOutbox = (mail: MailStore, input: NewOutbox): Promise<OutboxRecord> =>
  mail.outboxMessage.create({
    accountId: input.accountId,
    accountConfigId: input.accountConfigId,
    fromAddress: input.fromAddress,
    messageIdValue: input.messageIdValue,
    ...draftColumns(input.draft),
    status: "draft",
  });

export const updateOutboxDraft = async (
  mail: MailStore,
  accountConfigId: string,
  outboxMessageId: string,
  draft: OutboxDraft,
): Promise<MailResult<OutboxRecord>> => {
  const update = draftColumns(draft);
  const updated =
    (await mail.outboxMessage.updateIfStatus(accountConfigId, outboxMessageId, "draft", update)) ??
    (await mail.outboxMessage.updateIfStatus(accountConfigId, outboxMessageId, "failed", update));
  if (updated === null) return { ok: false, reason: "outbox message is not an editable draft" };
  return { ok: true, value: updated };
};

export const claimOutbox = async (
  mail: MailStore,
  accountConfigId: string,
  outboxMessageId: string,
): Promise<MailResult<OutboxRecord>> => {
  const claim = { status: "sending" as const, lastError: "" };
  const claimed =
    (await mail.outboxMessage.updateIfStatus(accountConfigId, outboxMessageId, "draft", claim)) ??
    (await mail.outboxMessage.updateIfStatus(accountConfigId, outboxMessageId, "failed", claim));
  if (claimed === null) return { ok: false, reason: "outbox message is not ready to send" };
  return { ok: true, value: claimed };
};

export const settleOutbox = (
  mail: MailStore,
  accountConfigId: string,
  outboxMessageId: string,
  change: OutboxStateChange,
): Promise<OutboxRecord> =>
  mail.outboxMessage.update(accountConfigId, outboxMessageId, {
    status: change.status,
    lastError: change.lastError ?? "",
    ...(change.sentAt === null ? {} : { sentAt: change.sentAt }),
  });
