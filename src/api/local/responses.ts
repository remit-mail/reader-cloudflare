import type {
  AccountConfigResponse,
  AccountResponse,
  AccountService,
  CanonicalMailboxRole,
  FolderAppointment,
} from "@remit/api-openapi-types";
import type { AccountConfigItem, AccountItem, MailboxItem } from "@remit/data-ports";

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

export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> => {
  const entry: Partial<Record<K, V>> = {};
  if (value === null || value === undefined) return entry;
  entry[key] = value;
  return entry;
};

const isInbox = (mailbox: MailboxItem): boolean => mailbox.fullPath.toUpperCase() === "INBOX";

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

const folderAppointments = (mailboxes: readonly MailboxItem[]): FolderAppointment[] =>
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
