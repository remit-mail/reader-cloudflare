import type { AddressFlags } from "@remit/api-openapi-types";
import type { RemitClientCore } from "@remit/backend/create-remit-client";
import type { AddressItem } from "@remit/data-ports";
import { storedFlags } from "./address-flags";
import type { MessageRecord } from "./types";

export type MailStore = Pick<
  RemitClientCore,
  "address" | "mailbox" | "message" | "messageFlag" | "threadMessage"
>;

const flagsOf = (address: AddressItem): AddressFlags =>
  storedFlags(address.flags ?? {}, address.addressId);

export const starOf = (starred: boolean) => (starred ? ("yellow" as const) : ("none" as const));

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
