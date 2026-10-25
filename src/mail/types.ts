import type { AddressFlags } from "@remit/api-openapi-types";
import type {
  AddressItem,
  EnvelopeAddressItem,
  MailboxItem,
  MailboxSpecialUseValue,
  MessageItem,
  OutboxMessageItem,
  SearchOptions,
  ThreadMessageItem,
} from "@remit/data-ports";

export type SpecialUse = MailboxSpecialUseValue;

export type AddressRole = EnvelopeAddressItem["addressRole"];

export interface MailAccount {
  readonly tenantId: string;
  readonly accountId: string;
  readonly accountConfigId: string;
}

export interface MailboxInput {
  readonly path: string;
  readonly delimiter: string;
  readonly namespacePrefix: string;
  readonly specialUse: readonly SpecialUse[];
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly highestModseq: string;
  readonly messageCount: number;
  readonly unseenCount: number;
}

export interface AddressInput {
  readonly name: string | null;
  readonly address: string;
}

export interface EnvelopeInput {
  readonly date: number;
  readonly dateRaw: string;
  readonly subject: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly from: readonly AddressInput[];
  readonly sender: readonly AddressInput[];
  readonly replyTo: readonly AddressInput[];
  readonly to: readonly AddressInput[];
  readonly cc: readonly AddressInput[];
  readonly bcc: readonly AddressInput[];
}

export interface MessageInput {
  readonly uid: number;
  readonly sequenceNumber: number;
  readonly rfc822Size: number;
  readonly internalDate: number;
  readonly envelope: EnvelopeInput;
  readonly flags: readonly string[];
  readonly hasAttachment: boolean;
  readonly snippet: string | null;
  readonly bodyStorageKey: string | null;
}

export type MailResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface MailboxRow extends MailboxItem {
  readonly storedMessages: number;
}

export type SortOrder = "asc" | "desc";

export interface ThreadSearch {
  readonly accountConfigId: string;
  readonly mailboxIds: readonly string[] | null;
  readonly search: SearchOptions;
  readonly order: SortOrder;
  readonly continuationToken: string | null;
  readonly limit: number;
  readonly results: boolean;
  readonly count: boolean;
}

export interface ThreadRow extends ThreadMessageItem {
  readonly senderFlags: AddressFlags;
}

export interface ThreadPage {
  readonly rows: readonly ThreadRow[] | null;
  readonly continuationToken: string | null;
  readonly count: number | null;
}

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

export interface MessageLocation {
  readonly messageId: string;
  readonly accountId: string;
  readonly mailboxId: string;
  readonly mailboxPath: string;
  readonly uid: number;
}

export interface FlagChange {
  readonly isRead: boolean | null;
  readonly isStarred: boolean | null;
}

export interface FlagState {
  readonly messageId: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
}

export type OutboxRecord = OutboxMessageItem;

export type OutboxStatus = OutboxMessageItem["status"];

export interface OutboxDraft {
  readonly toAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly bccAddresses: readonly string[];
  readonly subject: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
}

export interface NewOutbox {
  readonly accountId: string;
  readonly accountConfigId: string;
  readonly fromAddress: string;
  readonly messageIdValue: string;
  readonly draft: OutboxDraft;
}

export interface OutboxStateChange {
  readonly status: OutboxStatus;
  readonly lastError: string | null;
  readonly sentAt: number | null;
}

export type AddressRecord = AddressItem;

export type AddressUpdate =
  | { readonly kind: "Updated"; readonly address: AddressRecord }
  | { readonly kind: "NotFound" }
  | { readonly kind: "Invalid"; readonly reason: string };

export interface AddressPageRequest {
  readonly accountConfigId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SkippedMessage {
  readonly uid: number;
  readonly key: string;
  readonly reason: string;
}
