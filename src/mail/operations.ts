import type { AddressFlags } from "@remit/api-openapi-types";
import type { RemitClientCore } from "@remit/backend/create-remit-client";
import type { AddressItem } from "@remit/data-ports";
import { storedFlags } from "./address-flags";
import type {
  MailResult,
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
