import type { ImapFlow, ListResponse } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import type { AccountRow } from "../db/accounts";
import { type ImapCredential, openImap } from "./imap-connect";
import { openSmtp, type SmtpCredential } from "./smtp-connect";
import type { OutboxRecord } from "./types";

const SENT_NAMES = ["sent", "sent mail"];

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface AccountCredentials {
  readonly imap: ImapCredential;
  readonly smtp: SmtpCredential;
}

export type Delivery =
  | { readonly kind: "Sent"; readonly sentMailbox: string }
  | { readonly kind: "Unfiled"; readonly reason: string }
  | { readonly kind: "Failed"; readonly reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
  );

export const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

export const accountCredentials = (account: AccountRow, password: string): AccountCredentials => ({
  imap: {
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapTls,
    username: account.username,
    password,
  },
  smtp: {
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpTls,
    username: account.smtpUsername === "" ? account.username : account.smtpUsername,
    password,
  },
});

const nonEmpty = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

const nonEmptyList = (values: readonly string[]): string[] | undefined =>
  values.length === 0 ? undefined : [...values];

const composeMessage = async (outbox: OutboxRecord) => {
  const node = new MailComposer({
    from: outbox.fromAddress,
    to: nonEmptyList(outbox.toAddresses),
    cc: nonEmptyList(outbox.ccAddresses),
    bcc: nonEmptyList(outbox.bccAddresses),
    subject: outbox.subject ?? "",
    text: outbox.textBody ?? "",
    html: nonEmpty(outbox.htmlBody),
    inReplyTo: nonEmpty(outbox.inReplyTo),
    references: nonEmptyList(outbox.references),
    messageId: outbox.messageIdValue,
  }).compile();
  const raw: Uint8Array = await node.build();
  return { envelope: node.getEnvelope(), raw };
};

const isSentByName = (entry: ListResponse): boolean =>
  SENT_NAMES.includes(entry.name.toLowerCase());

const findSentMailbox = async (client: ImapFlow): Promise<string | undefined> => {
  const listed = await client.list();
  const sent = listed.find((entry) => entry.specialUse === "\\Sent") ?? listed.find(isSentByName);
  return sent?.path;
};

const appendSent = async (
  credential: ImapCredential,
  raw: Uint8Array,
): Promise<Outcome<string>> => {
  const client = await openImap(credential);
  try {
    const path = await findSentMailbox(client);
    if (path === undefined) return { ok: false, reason: "no Sent mailbox on the IMAP server" };
    const appended = await client.append(path, raw, ["\\Seen"]);
    if (appended === false) return { ok: false, reason: `append to ${path} was refused` };
    return { ok: true, value: path };
  } finally {
    client.close();
  }
};

const sendMessage = async (
  credential: SmtpCredential,
  envelope: { from: string | false; to: string[] },
  raw: Uint8Array,
): Promise<void> => {
  const transport = openSmtp(credential);
  try {
    await transport.sendMail({ envelope, raw });
  } finally {
    transport.close();
  }
};

export const deliver = async (
  credentials: AccountCredentials,
  outbox: OutboxRecord,
): Promise<Delivery> => {
  const { envelope, raw } = await composeMessage(outbox);
  const sent = await settle(sendMessage(credentials.smtp, envelope, raw));
  if (!sent.ok) return { kind: "Failed", reason: sent.reason };
  const appended = await settle(appendSent(credentials.imap, raw));
  if (!appended.ok) return { kind: "Unfiled", reason: appended.reason };
  if (!appended.value.ok) return { kind: "Unfiled", reason: appended.value.reason };
  return { kind: "Sent", sentMailbox: appended.value.value };
};

export const verifyImap = async (credential: ImapCredential): Promise<void> => {
  const client = await openImap(credential);
  await client.logout();
};

export const verifySmtp = async (credential: SmtpCredential): Promise<void> => {
  const transport = openSmtp(credential);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
};
