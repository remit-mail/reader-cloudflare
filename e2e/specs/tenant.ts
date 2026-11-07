import { readFileSync } from "node:fs";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import {
  imap,
  imapFromStack,
  mintImapUser,
  smtpFromStack,
} from "../.reader/packages/e2e/src/env.js";
import { appendRawMessage } from "../.reader/packages/e2e/src/imap.js";

export const baseUrl = (): string => {
  const url = process.env.E2E_BASE_URL;
  if (url === undefined) throw new Error("E2E_BASE_URL is not set; run `npm run e2e`");
  return url;
};

export type Json = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export const mintIdentity = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@remit.test`;

export type TenantRequest = (method: string, path: string, body?: unknown) => Promise<Response>;

export const tenantRequest =
  (identity: string): TenantRequest =>
  (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl()}/api${path}`, {
      method,
      headers: {
        "x-dev-identity": identity,
        origin: baseUrl(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

export const tenantJson =
  (identity: string): Json =>
  async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await tenantRequest(identity)(method, path, body);
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  };

// Every call names its own dev identity, so a spec starts from a tenant no
// earlier request has created.
export const freshTenant = (): Json => tenantJson(mintIdentity("fresh"));

interface ListedMailbox {
  readonly mailboxId: string;
  readonly fullPath: string;
}

export interface ImapAccount {
  readonly accountId: string;
  readonly imapUser: string;
}

const NO_SMTP = { smtpEnabled: false };

const SMTP_TO_SINK = {
  smtpEnabled: true,
  smtpHost: smtpFromStack.host,
  smtpPort: smtpFromStack.port,
  smtpTls: false,
  smtpStartTls: false,
};

export interface ImapServer {
  readonly host: string;
  readonly port: number;
}

const connectAccount = async (
  json: Json,
  smtp: typeof NO_SMTP | typeof SMTP_TO_SINK,
  server: ImapServer,
): Promise<ImapAccount> => {
  const imapUser = mintImapUser();
  const { accountId } = await json<{ accountId: string }>("POST", "/accounts", {
    email: imapUser,
    username: imapUser,
    password: imap.password,
    imapHost: server.host,
    imapPort: server.port,
    imapTls: false,
    imapStartTls: false,
    ...smtp,
  });
  await json("POST", `/accounts/${accountId}/sync`);
  await waitFor(
    () =>
      json<{ items?: ListedMailbox[] }>("GET", `/accounts/${accountId}/mailboxes`).then(
        (page) => page.items ?? [],
      ),
    (listed) => listed.some((mailbox) => mailbox.fullPath === "INBOX"),
    { timeoutMs: 90_000, what: `the INBOX of ${imapUser}` },
  );
  return { accountId, imapUser };
};

export const connectImapAccount = (
  json: Json,
  server: ImapServer = imapFromStack,
): Promise<ImapAccount> => connectAccount(json, NO_SMTP, server);

// Sends go to the Mailpit sink, which is where a spec reads what left the Worker.
export const connectSendingAccount = (json: Json): Promise<ImapAccount> =>
  connectAccount(json, SMTP_TO_SINK, imapFromStack);

export interface Invitation {
  readonly summary: string;
  readonly uid: string;
  readonly start: string;
  readonly end: string;
}

const icalUtc = (iso: string): string =>
  `${new Date(iso).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

export const invitation = (name: string, start: string, end: string): Invitation => {
  const slug = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { summary: `Invitation ${slug}`, uid: `${slug}@remit.test`, start, end };
};

const invitationMessage = (invite: Invitation, recipient: string): string => {
  const organizer = `organiser-${invite.uid}`;
  const vcalendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Remit e2e//Invitation//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    "DTSTAMP:20260901T090000Z",
    "SEQUENCE:0",
    `DTSTART:${icalUtc(invite.start)}`,
    `DTEND:${icalUtc(invite.end)}`,
    `SUMMARY:${invite.summary}`,
    `ORGANIZER:mailto:${organizer}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${recipient}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return [
    `From: Organiser <${organizer}>`,
    `To: ${recipient}`,
    `Subject: ${invite.summary}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${invite.uid.replace("@", ".msg@")}>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="remit-e2e-invite"',
    "",
    "--remit-e2e-invite",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    `You are invited to ${invite.summary}.`,
    "--remit-e2e-invite",
    'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"',
    "",
    vcalendar,
    "--remit-e2e-invite--",
    "",
  ].join("\r\n");
};

export interface PendingSuggestion {
  readonly suggestionId: string;
  readonly summary: string;
}

// The suggestion lives in the tenant's mail object, written by the body batch
// after a sync; it is the proof the invitation was read out of the mail.
export const deliverInvitation = async (
  json: Json,
  account: ImapAccount,
  invite: Invitation,
): Promise<PendingSuggestion> => {
  await appendRawMessage(account.imapUser, invitationMessage(invite, account.imapUser));
  await json("POST", `/accounts/${account.accountId}/sync`);
  const pending = await waitFor(
    () => pendingSuggestions(json),
    (items) => items.some((item) => item.summary === invite.summary),
    { timeoutMs: 120_000, what: `a pending suggestion for "${invite.summary}"` },
  );
  const suggestion = pending.find((item) => item.summary === invite.summary);
  if (suggestion === undefined) throw new Error("matched but not found");
  return suggestion;
};

export const pendingSuggestions = (json: Json): Promise<PendingSuggestion[]> =>
  json<{ items: PendingSuggestion[] }>("GET", "/calendar-suggestions?state=Pending").then(
    (page) => page.items,
  );

export interface Calendar {
  readonly calendarId: string;
  readonly source: string;
  readonly componentSet: string;
}

export const defaultCalendarId = async (json: Json): Promise<string> => {
  const { items } = await json<{ items: Calendar[] }>("GET", "/calendars");
  const calendar = items.find(
    (candidate) => candidate.source === "Default" && candidate.componentSet === "VeventOnly",
  );
  if (calendar === undefined) throw new Error("the tenant has no default calendar");
  return calendar.calendarId;
};

export interface EventInstance {
  readonly calendarId: string;
  readonly calendarObjectId: string;
  readonly recurrenceId: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
}

export const eventsBetween = (json: Json, from: string, to: string): Promise<EventInstance[]> =>
  json<{ items?: EventInstance[] }>(
    "GET",
    `/calendar-events?${new URLSearchParams({ from, to })}`,
  ).then((page) => page.items ?? []);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const plainTextUrlOf = (description: unknown): string => {
  if (!isRecord(description) || !Array.isArray(description.bodyParts)) {
    throw new Error("GET /messages/{messageId} has no bodyParts");
  }
  const part: unknown = description.bodyParts.find(
    (entry: unknown) =>
      isRecord(entry) &&
      typeof entry.mediaType === "string" &&
      typeof entry.mediaSubtype === "string" &&
      `${entry.mediaType}/${entry.mediaSubtype}`.toLowerCase() === "text/plain",
  );
  if (!isRecord(part) || typeof part.contentUrl !== "string") {
    throw new Error("GET /messages/{messageId} has no text/plain part");
  }
  return part.contentUrl;
};

const finalizedDeletesSince = (since: number): number => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"queue.consume"') && line.includes("FinalizeAccountDelete"))
    .map((line): unknown => JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1)))
    .filter(isRecord)
    .filter(
      (record) =>
        record.type === "FinalizeAccountDelete" &&
        record.outcome === "Acked" &&
        typeof record.time === "string" &&
        Date.parse(record.time) >= since,
    ).length;
};

// The scheduler tick scans every tenant's account config in D1, so a spec that
// leaves its tenant behind changes what a later spec's tick counts.
export const eraseTenant = async (json: Json, identity: string): Promise<void> => {
  const erasedAt = Date.now();
  await json("DELETE", "/me", { confirmEmail: identity });
  await waitFor(
    async () => finalizedDeletesSince(erasedAt),
    (count) => count > 0,
    { timeoutMs: 60_000, what: `the erase of ${identity}` },
  );
};
