import type { envelopeAddresses, mailboxSpecialUseEntries } from "./schema";

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

export interface MessageSummary {
  readonly messageId: string;
  readonly threadId: string;
  readonly uid: number;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly sentDate: number;
  readonly internalDate: number;
  readonly isRead: boolean;
  readonly isFlagged: boolean;
  readonly hasAttachment: boolean;
  readonly snippet: string | null;
}

export interface MessagePage {
  readonly messages: readonly MessageSummary[];
  readonly nextBefore: string | null;
}

export interface EnvelopeAddressView {
  readonly role: AddressRole;
  readonly order: number;
  readonly name: string | null;
  readonly email: string;
}

export interface MessageView {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly uid: number;
  readonly rfc822Size: number;
  readonly internalDate: number;
  readonly messageIdHeader: string | null;
  readonly bodyStorageKey: string | null;
  readonly date: number;
  readonly dateRaw: string;
  readonly subject: string | null;
  readonly addresses: readonly EnvelopeAddressView[];
  readonly flags: readonly string[];
}

export type MailResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };
