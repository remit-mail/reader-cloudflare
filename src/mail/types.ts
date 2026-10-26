import type { AddressFlags } from "@remit/api-openapi-types";
import type {
  EnvelopeAddressItem,
  MailboxSpecialUseValue,
  MessageItem,
  OutboxMessageItem,
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
  readonly messageId: string;
  readonly uid: number;
  readonly sequenceNumber: number;
  readonly rfc822Size: number;
  readonly internalDate: number;
  readonly envelope: EnvelopeInput;
  readonly flags: readonly string[];
  readonly hasAttachment: boolean;
}

export interface SyncedMessage {
  readonly messageId: string;
  readonly uid: number;
}

export interface BodyBatch {
  readonly account: MailAccount;
  readonly mailboxId: string;
  readonly messages: readonly SyncedMessage[];
  readonly attempts: number;
}

export interface BodyBatchResult {
  readonly synced: number;
  readonly skipped: number;
  readonly failed: number;
  readonly bytes: number;
}

export type MailResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

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

export type OutboxRecord = OutboxMessageItem;

type OutboxStatus = OutboxMessageItem["status"];

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

export interface AddressPageRequest {
  readonly accountConfigId: string;
  readonly cursor?: string;
  readonly limit?: number;
}
