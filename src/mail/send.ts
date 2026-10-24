import type { ImapFlow, ListResponse } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import type { Tenant } from "../access";
import { type AccountView, decryptCredential, getAccount } from "../db/accounts";
import { openAppDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";
import { type ImapCredential, openImap } from "./imap-connect";
import { openSmtp } from "./smtp-connect";

const SEND_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/send$/;
const SENT_NAMES = ["sent", "sent mail"];

export const sendBodySchema = z
  .object({
    to: z.array(z.email()),
    cc: z.array(z.email()),
    bcc: z.array(z.email()),
    subject: z.string(),
    text: z.string(),
    html: z.string(),
    inReplyTo: z.string(),
    references: z.array(z.string().min(1)),
  })
  .refine((body) => body.to.length + body.cc.length + body.bcc.length > 0, {
    message: "at least one recipient is required",
  });

export type SendBody = z.infer<typeof sendBodySchema>;

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
  );

const matchAccountId = (path: string): string | null => SEND_PATH.exec(path)?.[1] ?? null;

export const isSendPath = (path: string): boolean => matchAccountId(path) !== null;

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

const nonEmpty = (value: string): string | undefined => (value === "" ? undefined : value);

const nonEmptyList = (values: readonly string[]): string[] | undefined =>
  values.length === 0 ? undefined : [...values];

const composeMessage = async (from: string, body: SendBody) => {
  const messageId = `<${crypto.randomUUID()}@${domainOf(from)}>`;
  const node = new MailComposer({
    from,
    to: nonEmptyList(body.to),
    cc: nonEmptyList(body.cc),
    bcc: nonEmptyList(body.bcc),
    subject: body.subject,
    text: body.text,
    html: nonEmpty(body.html),
    inReplyTo: nonEmpty(body.inReplyTo),
    references: nonEmptyList(body.references),
    messageId,
  }).compile();
  const raw: Uint8Array = await node.build();
  return { messageId, envelope: node.getEnvelope(), raw };
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
  credential: ImapCredential,
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

const credentialFor = (
  server: AccountView["smtp"],
  account: AccountView,
  password: string,
): ImapCredential => ({
  host: server.host,
  port: server.port,
  secure: server.secure,
  username: account.username,
  password,
});

export const sendApi = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  const accountId = matchAccountId(path);
  if (accountId === null || request.method !== "POST") return notFound();
  const parsed = sendBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid message", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const db = openAppDb(env.DB);
  const account = await getAccount(db, tenant.tenantId, accountId);
  if (account === undefined) return notFound();
  const fields = { tenantId: tenant.tenantId, accountId };
  const secret = await decryptCredential(env, db, tenant.tenantId, accountId);
  if (!secret.ok) {
    log.error("send failed", { ...fields, reason: secret.reason });
    return Response.json({ error: "send failed", reason: secret.reason }, { status: 500 });
  }
  const { messageId, envelope, raw } = await composeMessage(account.email, parsed.data);
  const recipients = envelope.to.length;
  const smtpStarted = Date.now();
  const sent = await settle(
    sendMessage(credentialFor(account.smtp, account, secret.plaintext), envelope, raw),
  );
  const smtpMs = Date.now() - smtpStarted;
  if (!sent.ok) {
    log.error("send failed", { ...fields, messageId, recipients, smtpMs, reason: sent.reason });
    return Response.json({ error: "send failed", reason: sent.reason }, { status: 502 });
  }
  const appendStarted = Date.now();
  const appended = await settle(
    appendSent(credentialFor(account.imap, account, secret.plaintext), raw),
  ).then((outcome): Outcome<string> => (outcome.ok ? outcome.value : outcome));
  const appendMs = Date.now() - appendStarted;
  if (!appended.ok) {
    log.error("sent copy not appended", {
      ...fields,
      messageId,
      recipients,
      smtpMs,
      appendMs,
      reason: appended.reason,
    });
    return Response.json(
      { sent: true, appended: false, messageId, reason: appended.reason },
      { status: 502 },
    );
  }
  log.info("message sent", {
    ...fields,
    messageId,
    recipients,
    smtpMs,
    appendMs,
    sentMailbox: appended.value,
  });
  return Response.json({ messageId, sentMailbox: appended.value });
};
