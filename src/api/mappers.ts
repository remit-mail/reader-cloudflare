import type {
  AccountConfigResponse,
  AccountResponse,
  AccountService,
  AddressResponse,
  CanonicalMailboxRole,
  FolderAppointment,
  MailboxResponse,
  OutboxMessageResponse,
  ThreadMessageResponse,
} from "@remit/api-openapi-types";
import type { AccountConfigItem, AccountItem, MailboxItem } from "@remit/data-ports";
import { isMuted, senderTrustOf, storedFlags } from "../mail/address-flags";
import type { AddressRecord, MailboxRow, OutboxRecord, ThreadRow } from "../mail/types";
import { optional } from "./respond";

const ROLES: readonly CanonicalMailboxRole[] = [
  "Inbox",
  "Drafts",
  "Sent",
  "Archive",
  "Junk",
  "Trash",
  "All",
  "Flagged",
];

const SERVICES: readonly AccountService[] = ["Mail", "Calendar"];

const isInbox = (mailbox: MailboxItem): boolean => mailbox.fullPath.toUpperCase() === "INBOX";

export const inboxesOf = (mailboxes: readonly MailboxItem[]): MailboxItem[] =>
  mailboxes.filter(isInbox);

const services = (value: unknown): AccountService[] =>
  Array.isArray(value) ? SERVICES.filter((service) => value.includes(service)) : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const appointment = (role: CanonicalMailboxRole, mailboxes: readonly MailboxItem[]) => {
  if (role === "Inbox") {
    const inbox = mailboxes.find(isInbox);
    if (inbox !== undefined)
      return { role, source: "Reserved" as const, mailboxId: inbox.mailboxId };
    return { role, source: "None" as const };
  }
  const flagged = mailboxes.find((mailbox) =>
    (mailbox.specialUse ?? []).some((use) => use === role),
  );
  if (flagged !== undefined)
    return { role, source: "Flagged" as const, mailboxId: flagged.mailboxId };
  return { role, source: "None" as const };
};

export const folderAppointments = (mailboxes: readonly MailboxItem[]): FolderAppointment[] =>
  ROLES.map((role) => appointment(role, mailboxes));

export const toAccountConfigResponse = (row: AccountConfigItem): AccountConfigResponse => ({
  accountConfigId: row.accountConfigId,
  userId: row.userId,
  ...optional("name", row.name),
  state: row.state,
  ...optional("deletedAt", row.deletedAt),
  ...optional("cascadeStartedAt", row.cascadeStartedAt),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toAccountResponse = (
  row: AccountItem,
  mailboxes: readonly MailboxItem[],
): AccountResponse => ({
  accountId: row.accountId,
  accountConfigId: row.accountConfigId,
  username: row.username,
  email: row.email,
  authType: row.authType,
  syncedServices: services(row.syncedServices),
  grantedScopes: strings(row.grantedScopes),
  imapHost: row.imapHost,
  imapPort: row.imapPort,
  imapTls: row.imapTls,
  imapStartTls: row.imapStartTls,
  smtpEnabled: row.smtpEnabled,
  smtpHost: row.smtpHost,
  smtpPort: row.smtpPort,
  smtpTls: row.smtpTls,
  smtpStartTls: row.smtpStartTls,
  smtpUsername: row.smtpUsername,
  isActive: row.isActive,
  connectionState: row.connectionState,
  ...optional("lastConnectedAt", row.lastConnectedAt),
  ...optional("lastSyncAt", row.lastSyncAt),
  ...optional("lastError", row.lastError),
  ...optional("syncPhase", row.syncPhase),
  ...optional("mailboxCountTotal", row.mailboxCountTotal),
  ...optional("mailboxCountSynced", row.mailboxCountSynced),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  folderAppointments: folderAppointments(
    mailboxes.filter((mailbox) => mailbox.accountId === row.accountId),
  ),
});

export const toMailboxResponse = (row: MailboxRow): MailboxResponse => ({
  mailboxId: row.mailboxId,
  accountId: row.accountId,
  namespaceType: row.namespaceType,
  namespacePrefix: row.namespacePrefix,
  hierarchyDelimiter: row.hierarchyDelimiter,
  fullPath: row.fullPath,
  messageCount: row.messageCount,
  unseenCount: row.unseenCount,
  deletedCount: row.deletedCount,
  lastSyncUid: row.lastSyncUid,
  highWaterMarkUid: row.highWaterMarkUid,
  lastMessageSyncAt: row.lastMessageSyncAt,
  syncStatus: row.syncStatus,
  syncFailureReason: row.syncFailureReason,
  specialUse: [...(row.specialUse ?? [])],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toThreadMessageResponse = (
  row: ThreadRow,
  accountIds: ReadonlyMap<string, string>,
): ThreadMessageResponse => ({
  threadMessageId: row.threadMessageId,
  threadId: row.threadId,
  messageId: row.messageId,
  accountConfigId: row.accountConfigId,
  mailboxId: row.mailboxId,
  ...optional("fromEmail", row.fromEmail),
  ...optional("fromName", row.fromName),
  ...optional("subject", row.subject),
  sentDate: row.sentDate,
  isRead: row.isRead,
  hasAttachment: row.hasAttachment,
  star: row.star,
  hasStars: row.hasStars,
  isDeleted: row.isDeleted,
  ...optional("snippet", row.snippet),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  category: row.category,
  senderTrust: senderTrustOf(row.senderFlags),
  muted: isMuted(row.senderFlags),
  status: "active",
  syncStatus: "synced",
  abandonedMutation: "none",
  ...optional("accountId", accountIds.get(row.mailboxId)),
});

export const accountIdsByMailbox = (mailboxes: readonly MailboxItem[]): Map<string, string> =>
  new Map(mailboxes.map((mailbox) => [mailbox.mailboxId, mailbox.accountId]));

export const toOutboxMessageResponse = (record: OutboxRecord): OutboxMessageResponse => ({
  outboxMessageId: record.outboxMessageId,
  accountId: record.accountId,
  fromAddress: record.fromAddress,
  ...optional("fromName", record.fromName),
  toAddresses: [...record.toAddresses],
  ccAddresses: [...record.ccAddresses],
  bccAddresses: [...record.bccAddresses],
  ...optional("subject", record.subject),
  ...optional("inReplyTo", record.inReplyTo),
  references: [...record.references],
  ...optional("textBody", record.textBody),
  ...optional("htmlBody", record.htmlBody),
  status: record.status,
  ...optional("lastError", record.lastError),
  ...optional("sentAt", record.sentAt),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  attachments: [],
});

export const toAddressResponse = (record: AddressRecord): AddressResponse => ({
  addressId: record.addressId,
  accountConfigId: record.accountConfigId,
  ...optional("displayName", record.displayName),
  localPart: record.localPart,
  domain: record.domain,
  normalizedEmail: record.normalizedEmail,
  flags: storedFlags(record.flags ?? {}, record.addressId),
  inboundCount: record.inboundCount,
  outboundCount: record.outboundCount,
  replyCount: record.replyCount,
  lastInboundAt: record.lastInboundAt,
  lastReplyAt: record.lastReplyAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});
