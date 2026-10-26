import type { AddressFlags } from "@remit/api-openapi-types";
import type { EnvelopeAddressItem, MessageItem } from "@remit/data-ports";

export type AddressRole = EnvelopeAddressItem["addressRole"];

export interface EnvelopeAddressRecord {
  readonly addressId: string;
  readonly role: AddressRole;
  readonly order: number;
  readonly displayName: string | null;
  readonly email: string;
  readonly flags: AddressFlags;
}

export interface MessageRecord {
  readonly message: MessageItem;
  readonly accountId: string;
  readonly mailboxPath: string;
  readonly date: number;
  readonly subject: string | null;
  readonly messageIdValue: string | null;
  readonly addresses: readonly EnvelopeAddressRecord[];
  readonly flags: readonly string[];
}
