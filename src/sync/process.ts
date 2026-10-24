import type { Env } from "../env";
import { log } from "../log";
import { parseEmail, toAddressInputs, toDisplay } from "../mail/parse";
import type { MailAccount, MessageInput } from "../mail/types";
import type { SearchDocument } from "../search/types";
import { tenantMail, tenantSearch } from "../stubs";
import { objectMetadataSchema, type ProcessBatch, syncMessageSchema } from "./messages";

const SNIPPET_LENGTH = 200;

interface ProcessedMessage {
  readonly parseMs: number;
  readonly input: MessageInput;
  readonly search: Omit<SearchDocument, "messageId" | "mailboxId">;
}

const headerValue = (headers: readonly { key: string; value: string }[], key: string): string =>
  headers.find((header) => header.key === key)?.value ?? "";

const sentDate = (date: string | undefined, fallback: number): number => {
  if (date === undefined) return fallback;
  const time = Date.parse(date);
  return Number.isNaN(time) ? fallback : time;
};

const processObject = async (env: Env, key: string): Promise<ProcessedMessage> => {
  const object = await env.MAIL.get(key);
  if (object === null) throw new Error(`object ${key} not found`);
  const metadata = objectMetadataSchema.parse(object.customMetadata);
  const parseStarted = Date.now();
  const email = await parseEmail(object.body);
  const parseMs = Date.now() - parseStarted;
  const text = email.text ?? "";
  return {
    parseMs,
    input: {
      uid: metadata.uid,
      sequenceNumber: metadata.sequenceNumber,
      rfc822Size: metadata.rfc822Size,
      internalDate: metadata.internalDate,
      envelope: {
        date: sentDate(email.date, metadata.internalDate),
        dateRaw: headerValue(email.headers, "date"),
        subject: email.subject ?? null,
        messageId: email.messageId ?? null,
        inReplyTo: email.inReplyTo ?? null,
        from: toAddressInputs(email.from === undefined ? [] : [email.from]),
        sender: toAddressInputs(email.sender === undefined ? [] : [email.sender]),
        replyTo: toAddressInputs(email.replyTo),
        to: toAddressInputs(email.to),
        cc: toAddressInputs(email.cc),
        bcc: toAddressInputs(email.bcc),
      },
      flags: metadata.flags,
      hasAttachment: email.attachments.length > 0,
      snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
      bodyStorageKey: key,
    },
    search: {
      subject: email.subject ?? "",
      from: toDisplay(email.from === undefined ? [] : [email.from]),
      to: toDisplay(email.to),
      bodyText: text,
    },
  };
};

const processBatch = async (env: Env, body: ProcessBatch): Promise<void> => {
  const started = Date.now();
  const account: MailAccount = {
    tenantId: body.tenantId,
    accountId: body.accountId,
    accountConfigId: body.accountConfigId,
  };
  const processed: ProcessedMessage[] = [];
  for (const key of body.keys) processed.push(await processObject(env, key));
  const upserted = await tenantMail(env, account.tenantId).upsertMessages(
    account,
    body.mailboxId,
    processed.map((message) => message.input),
  );
  if (!upserted.ok) throw new Error(`upsert ${body.mailboxId}: ${upserted.reason}`);
  const docs = upserted.value.flatMap((stored, index): SearchDocument[] => {
    const message = processed[index];
    if (message === undefined) return [];
    return [{ ...message.search, messageId: stored.messageId, mailboxId: body.mailboxId }];
  });
  await tenantSearch(env, account.tenantId).indexMessages(account, docs);
  const durationMs = Date.now() - started;
  const parseMs = processed.reduce((total, message) => total + message.parseMs, 0);
  log.info("batch processed", {
    tenantId: account.tenantId,
    accountId: account.accountId,
    mailboxId: body.mailboxId,
    count: processed.length,
    durationMs,
    parseMs,
    perMessageMs: Math.round(durationMs / processed.length),
    parsePerMessageMs: Math.round(parseMs / processed.length),
  });
};

export const processSyncMessage = async (env: Env, body: unknown): Promise<void> => {
  const message = syncMessageSchema.parse(body);
  if (message.kind === "ProcessBatch") await processBatch(env, message);
};

export const describeSyncMessage = (body: unknown): Record<string, unknown> => {
  const message = syncMessageSchema.safeParse(body);
  if (!message.success) return { kind: "Unknown" };
  return {
    kind: message.data.kind,
    tenantId: message.data.tenantId,
    accountId: message.data.accountId,
    mailboxId: message.data.mailboxId,
    keys: message.data.keys.length,
  };
};
