import { AddressRole, MailboxSpecialUse } from "@remit/domain-enums";
import type { ThreadRowData } from "@remit/ui";
import type { Mailbox, Message, MessageSummary } from "./api";

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

export const timeLabel = (epochMs: number): string => {
  const date = new Date(epochMs);
  if (sameDay(date, new Date())) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export const fullDate = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const summaryRow = (message: MessageSummary): ThreadRowData => ({
  id: message.messageId,
  threadId: message.threadId,
  fromName: message.fromName ?? message.fromEmail ?? "",
  fromEmail: message.fromEmail ?? "",
  subject: message.subject ?? "(no subject)",
  snippet: message.snippet ?? "",
  timeLabel: timeLabel(message.sentDate),
  sentDate: message.sentDate,
  isRead: message.isRead,
  hasAttachment: message.hasAttachment,
  starred: message.isFlagged,
});

export const sender = (message: Message): Message["addresses"][number] | undefined =>
  message.addresses.find((address) => address.role === AddressRole.From);

export const searchRow = (message: Message): ThreadRowData => {
  const from = sender(message);
  return {
    id: message.messageId,
    mailboxId: message.mailboxId,
    fromName: from?.name ?? from?.email ?? "",
    fromEmail: from?.email ?? "",
    subject: message.subject ?? "(no subject)",
    snippet: "",
    timeLabel: timeLabel(message.date),
    sentDate: message.date,
    isRead: message.flags.includes("\\Seen"),
  };
};

const SPECIAL_ORDER: readonly string[] = [
  MailboxSpecialUse.Drafts,
  MailboxSpecialUse.Sent,
  MailboxSpecialUse.Archive,
  MailboxSpecialUse.All,
  MailboxSpecialUse.Flagged,
  MailboxSpecialUse.Important,
  MailboxSpecialUse.Junk,
  MailboxSpecialUse.Trash,
];

const isInbox = (mailbox: Mailbox): boolean => mailbox.path.toUpperCase() === "INBOX";

const rank = (mailbox: Mailbox): number => {
  if (isInbox(mailbox)) return 0;
  const special = SPECIAL_ORDER.findIndex((use) => mailbox.specialUse.includes(use));
  return special === -1 ? SPECIAL_ORDER.length + 1 : special + 1;
};

export const sortMailboxes = (mailboxes: readonly Mailbox[]): Mailbox[] =>
  [...mailboxes].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));

export const defaultMailbox = (mailboxes: readonly Mailbox[]): Mailbox | undefined =>
  mailboxes.find(isInbox) ?? mailboxes[0];

export const depthOf = (mailbox: Mailbox): number =>
  mailbox.delimiter === "" ? 0 : mailbox.path.split(mailbox.delimiter).length - 1;
