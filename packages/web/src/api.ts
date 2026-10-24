import { type SyncState, syncStateSchema } from "sync-state";
import { z } from "zod";

const server = z.object({ host: z.string(), port: z.number(), secure: z.boolean() });

const me = z.object({ tenantId: z.string(), email: z.string() });

const account = z.object({
  accountId: z.string(),
  accountConfigId: z.string(),
  name: z.string(),
  email: z.string(),
  username: z.string(),
  imap: server,
  smtp: server,
  connectionState: z.string(),
  createdAt: z.number(),
});

const mailbox = z.object({
  mailboxId: z.string(),
  path: z.string(),
  delimiter: z.string(),
  parentMailboxId: z.string(),
  specialUse: z.array(z.string()),
  uidValidity: z.number(),
  uidNext: z.number(),
  messageCount: z.number(),
  unseenCount: z.number(),
  lastSyncUid: z.number(),
});

const messageSummary = z.object({
  messageId: z.string(),
  threadId: z.string(),
  uid: z.number(),
  subject: z.string().nullable(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  sentDate: z.number(),
  internalDate: z.number(),
  isRead: z.boolean(),
  isFlagged: z.boolean(),
  hasAttachment: z.boolean(),
  snippet: z.string().nullable(),
});

const messagePage = z.object({
  messages: z.array(messageSummary),
  nextBefore: z.string().nullable(),
});

const address = z.object({
  role: z.string(),
  order: z.number(),
  name: z.string().nullable(),
  email: z.string(),
});

const message = z.object({
  messageId: z.string(),
  mailboxId: z.string(),
  uid: z.number(),
  messageIdHeader: z.string().nullable(),
  date: z.number(),
  subject: z.string().nullable(),
  addresses: z.array(address),
  flags: z.array(z.string()),
});

const body = z.object({
  text: z.string(),
  html: z.string(),
  attachments: z.array(z.object({ filename: z.string(), mimeType: z.string(), size: z.number() })),
});

const searchResult = z.object({ messages: z.array(message) });

const sent = z.object({ messageId: z.string(), sentMailbox: z.string() });

const failure = z.object({
  error: z.string(),
  reason: z.string().optional(),
  sent: z.boolean().optional(),
  issues: z.array(z.object({ path: z.array(z.unknown()), message: z.string() })).optional(),
});

export type Me = z.infer<typeof me>;
export type Account = z.infer<typeof account>;
export type Mailbox = z.infer<typeof mailbox>;
export type MessageSummary = z.infer<typeof messageSummary>;
export type MessagePage = z.infer<typeof messagePage>;
export type Message = z.infer<typeof message>;
export type MessageBody = z.infer<typeof body>;
export type Sent = z.infer<typeof sent>;
export type { SyncState };

export interface ServerInput {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface NewAccount {
  readonly name: string;
  readonly imap: ServerInput;
  readonly smtp: ServerInput;
  readonly username: string;
  readonly password: string;
}

export interface Outgoing {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "signed-out"; readonly reason: string }
  | { readonly kind: "failed"; readonly status: number; readonly reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeIssues = (issues: z.infer<typeof failure>["issues"]): string | null => {
  if (issues === undefined || issues.length === 0) return null;
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
};

const describeFailure = async (response: Response): Promise<string> => {
  const json: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = failure.safeParse(json);
  if (!parsed.success) {
    const excerpt = (await response.text()).trim().slice(0, 300);
    return excerpt === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${excerpt}`;
  }
  const detail = parsed.data.reason ?? describeIssues(parsed.data.issues) ?? parsed.data.error;
  if (parsed.data.sent === true) {
    return `The mail was sent, but its copy was not saved to Sent: ${detail}`;
  }
  return detail === parsed.data.error ? detail : `${parsed.data.error}: ${detail}`;
};

const request = async <T>(
  schema: z.ZodType<T>,
  path: string,
  init: RequestInit,
): Promise<ApiResult<T>> => {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "manual",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  }).catch((error: unknown) => reasonOf(error));
  if (typeof response === "string") {
    return { kind: "failed", status: 0, reason: `Network error: ${response}` };
  }
  if (response.status === 401)
    return { kind: "signed-out", reason: await describeFailure(response) };
  if (response.type === "opaqueredirect") {
    return { kind: "signed-out", reason: "Cloudflare Access asked to sign in again." };
  }
  if (!response.ok) {
    return { kind: "failed", status: response.status, reason: await describeFailure(response) };
  }
  const json: unknown = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "failed",
      status: response.status,
      reason: `Unexpected response from ${path}: ${describeIssues(parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))) ?? "not JSON"}`,
    };
  }
  return { kind: "ok", value: parsed.data };
};

const get = <T>(schema: z.ZodType<T>, path: string): Promise<ApiResult<T>> =>
  request(schema, path, { method: "GET" });

const post = <T>(schema: z.ZodType<T>, path: string, payload: unknown): Promise<ApiResult<T>> =>
  request(schema, path, { method: "POST", body: JSON.stringify(payload) });

const accountPath = (accountId: string): string => `/api/accounts/${encodeURIComponent(accountId)}`;

export const api = {
  me: () => get(me, "/api/me"),
  accounts: () => get(z.array(account), "/api/accounts"),
  createAccount: (input: NewAccount) => post(account, "/api/accounts", input),
  startSync: (accountId: string) => post(syncStateSchema, `${accountPath(accountId)}/sync`, {}),
  syncStatus: (accountId: string) => get(syncStateSchema, `${accountPath(accountId)}/sync`),
  mailboxes: (accountId: string) => get(z.array(mailbox), `${accountPath(accountId)}/mailboxes`),
  messages: (accountId: string, mailboxId: string, before: string | null) => {
    const query = new URLSearchParams({ limit: "50" });
    if (before !== null) query.set("before", before);
    return get(
      messagePage,
      `${accountPath(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/messages?${query}`,
    );
  },
  message: (accountId: string, messageId: string) =>
    get(message, `${accountPath(accountId)}/messages/${encodeURIComponent(messageId)}`),
  body: (accountId: string, messageId: string) =>
    get(body, `${accountPath(accountId)}/messages/${encodeURIComponent(messageId)}/body`),
  search: (accountId: string, q: string) => {
    const query = new URLSearchParams({ q, limit: "50" });
    return get(searchResult, `${accountPath(accountId)}/search?${query}`);
  },
  send: (accountId: string, outgoing: Outgoing) =>
    post(sent, `${accountPath(accountId)}/send`, outgoing),
};
