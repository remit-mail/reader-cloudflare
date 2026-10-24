import type { AddressFlags } from "@remit/api-openapi-types";
import type {
  addresses,
  envelopeAddresses,
  mailboxes,
  mailboxSpecialUseEntries,
  messages,
  outboxMessages,
  threadMessages,
} from "./schema";

export type SpecialUse = (typeof mailboxSpecialUseEntries.$inferInsert)["specialUse"];

export type AddressRole = (typeof envelopeAddresses.$inferInsert)["addressRole"];

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

export interface MailboxView {
  readonly mailboxId: string;
  readonly path: string;
  readonly delimiter: string;
  readonly parentMailboxId: string;
  readonly specialUse: readonly SpecialUse[];
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messageCount: number;
  readonly unseenCount: number;
  readonly lastSyncUid: number;
}

export type MailResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export type ThreadMessageRow = typeof threadMessages.$inferSelect;

export type MailboxSyncStatus = (typeof mailboxes.$inferSelect)["syncStatus"];

export type NamespaceType = (typeof mailboxes.$inferSelect)["namespaceType"];

export type OutboxStatus = (typeof outboxMessages.$inferSelect)["status"];

export interface MailboxRow {
  readonly mailboxId: string;
  readonly accountId: string;
  readonly namespaceType: NamespaceType;
  readonly namespacePrefix: string;
  readonly hierarchyDelimiter: string;
  readonly fullPath: string;
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messageCount: number;
  readonly unseenCount: number;
  readonly deletedCount: number;
  readonly lastSyncUid: number;
  readonly highWaterMarkUid: number;
  readonly lastMessageSyncAt: number;
  readonly syncStatus: MailboxSyncStatus;
  readonly syncFailureReason: string;
  readonly specialUse: readonly SpecialUse[];
  readonly storedMessages: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadCursor {
  readonly sentDate: number;
  readonly messageId: string;
}

export type SortOrder = "asc" | "desc";

export interface ThreadQuery {
  readonly mailboxIds: readonly string[];
  readonly messageIds: readonly string[] | null;
  readonly unread: boolean | null;
  readonly starred: boolean | null;
  readonly attachments: boolean | null;
  readonly from: string | null;
  readonly subject: string | null;
  readonly order: SortOrder;
  readonly cursor: ThreadCursor | null;
  readonly limit: number;
}

export interface ThreadRow extends ThreadMessageRow {
  readonly senderFlags: AddressFlags;
}

export interface ThreadPage {
  readonly rows: readonly ThreadRow[];
  readonly next: ThreadCursor | null;
}

export interface MessageRecord {
  readonly messageId: string;
  readonly accountId: string;
  readonly mailboxId: string;
  readonly mailboxPath: string;
  readonly uid: number;
  readonly rfc822Size: number;
  readonly internalDate: number;
  readonly messageIdHeader: string | null;
  readonly bodyStorageKey: string | null;
  readonly status: (typeof messages.$inferSelect)["status"];
  readonly syncStatus: (typeof messages.$inferSelect)["syncStatus"];
  readonly abandonedMutation: (typeof messages.$inferSelect)["abandonedMutation"];
  readonly date: number;
  readonly subject: string | null;
  readonly messageIdValue: string | null;
  readonly category: ThreadMessageRow["category"];
  readonly addresses: readonly EnvelopeAddressRecord[];
  readonly flags: readonly string[];
}

export interface EnvelopeAddressRecord {
  readonly addressId: string;
  readonly role: AddressRole;
  readonly order: number;
  readonly displayName: string | null;
  readonly email: string;
  readonly flags: AddressFlags;
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

export interface OutboxRecord {
  readonly outboxMessageId: string;
  readonly accountId: string;
  readonly accountConfigId: string;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly toAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly bccAddresses: readonly string[];
  readonly subject: string | null;
  readonly messageIdValue: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly status: OutboxStatus;
  readonly lastError: string | null;
  readonly sentAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

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

export type AddressRow = typeof addresses.$inferSelect;

export interface AddressRecord extends Omit<AddressRow, "flags"> {
  readonly flags: AddressFlags;
}

export type AddressUpdate =
  | { readonly kind: "Updated"; readonly address: AddressRecord }
  | { readonly kind: "NotFound" }
  | { readonly kind: "Invalid"; readonly reason: string };

export interface FlagState {
  readonly messageId: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
}

export type MailboxEntity = Omit<typeof mailboxes.$inferSelect, "specialUse">;

export interface AddressPage {
  readonly items: readonly AddressRecord[];
  readonly next: string | null;
}

export interface ImportedAddress {
  readonly addressId: string;
  readonly accountConfigId: string;
  readonly displayName: string | null;
  readonly localPart: string;
  readonly domain: string;
  readonly normalizedEmail: string;
  readonly normalizedCompound: string;
  readonly flags: Readonly<Record<string, unknown>>;
}
