import type { Email } from "postal-mime";
import type { Env } from "../env";
import { log } from "../log";
import { parseEmail, toAddressInputs } from "../mail/parse";
import type { MailAccount, MessageInput, SkippedMessage } from "../mail/types";
import { tenantMail } from "../stubs";
import {
  type ObjectMetadata,
  objectMetadataSchema,
  type ProcessBatch,
  type SyncMessage,
  syncMessageSchema,
} from "./messages";

const SNIPPET_LENGTH = 200;

export const SYNC_DLQ = "reader-cloudflare-sync-dlq";

const REDRIVE_CHUNK = 5;

type ParseOutcome =
  | {
      readonly ok: true;
      readonly message: MessageInput;
      readonly parseMs: number;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly skipped: SkippedMessage;
      readonly parseMs: number;
      readonly bytes: number;
    };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const headerValue = (headers: readonly { key: string; value: string }[], key: string): string =>
  headers.find((header) => header.key === key)?.value ?? "";

const sentDate = (date: string | undefined, fallback: number): number => {
  if (date === undefined) return fallback;
  const time = Date.parse(date);
  return Number.isNaN(time) ? fallback : time;
};

const toMessageInput = (key: string, metadata: ObjectMetadata, email: Email): MessageInput => {
  const text = email.text ?? "";
  return {
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
  };
};

const parseObject = async (env: Env, key: string): Promise<ParseOutcome> => {
  const object = await env.MAIL.get(key);
  if (object === null) throw new Error(`object ${key} not found`);
  const metadata = objectMetadataSchema.parse(object.customMetadata);
  const started = Date.now();
  return parseEmail(object.body).then(
    (email): ParseOutcome => ({
      ok: true,
      message: toMessageInput(key, metadata, email),
      parseMs: Date.now() - started,
      bytes: object.size,
    }),
    (error: unknown): ParseOutcome => ({
      ok: false,
      skipped: { uid: metadata.uid, key, reason: reasonOf(error) },
      parseMs: Date.now() - started,
      bytes: object.size,
    }),
  );
};

const storeMessage = async (
  env: Env,
  account: MailAccount,
  mailboxId: string,
  message: MessageInput,
): Promise<void> => {
  const upserted = await tenantMail(env, account.tenantId).upsertMessages(account, mailboxId, [
    message,
  ]);
  if (!upserted.ok) throw new Error(`upsert ${mailboxId}: ${upserted.reason}`);
};

const processBatch = async (env: Env, body: ProcessBatch): Promise<void> => {
  const started = Date.now();
  const account: MailAccount = {
    tenantId: body.tenantId,
    accountId: body.accountId,
    accountConfigId: body.accountConfigId,
  };
  const skipped: SkippedMessage[] = [];
  let parseMs = 0;
  let bytes = 0;
  let stored = 0;
  for (const key of body.keys) {
    const outcome = await parseObject(env, key);
    parseMs += outcome.parseMs;
    bytes += outcome.bytes;
    if (!outcome.ok) {
      log.warn("message skipped", {
        tenantId: account.tenantId,
        accountId: account.accountId,
        mailboxId: body.mailboxId,
        uid: outcome.skipped.uid,
        key,
        reason: outcome.skipped.reason,
      });
      skipped.push(outcome.skipped);
      continue;
    }
    await storeMessage(env, account, body.mailboxId, outcome.message);
    stored += 1;
  }
  if (skipped.length > 0) {
    const recorded = await tenantMail(env, account.tenantId).recordSkippedMessages(
      account,
      body.mailboxId,
      body.uidValidity,
      skipped,
    );
    if (!recorded.ok) throw new Error(`skips ${body.mailboxId}: ${recorded.reason}`);
  }
  const durationMs = Date.now() - started;
  const count = body.keys.length;
  log.info("batch processed", {
    event: "sync.batch",
    tenantId: account.tenantId,
    accountId: account.accountId,
    mailboxId: body.mailboxId,
    messagesFetched: count,
    messagesStored: stored,
    messagesFailed: skipped.length,
    bytes,
    redrive: body.redrive,
    split: body.split,
    durationMs,
    parseMs,
    perMessageMs: Math.round(durationMs / count),
    parsePerMessageMs: Math.round(parseMs / count),
  });
};

const toSingles = (body: ProcessBatch): MessageSendRequest<SyncMessage>[] =>
  body.keys.map((key) => ({ body: { ...body, keys: [key], split: true } }));

const toRedrives = (body: ProcessBatch): MessageSendRequest<SyncMessage>[] => {
  const requests: MessageSendRequest<SyncMessage>[] = [];
  for (let index = 0; index < body.keys.length; index += REDRIVE_CHUNK) {
    const keys = body.keys.slice(index, index + REDRIVE_CHUNK);
    requests.push({ body: { ...body, keys, redrive: true, split: false } });
  }
  return requests;
};

const batchFields = (body: ProcessBatch): Record<string, unknown> => ({
  tenantId: body.tenantId,
  accountId: body.accountId,
  mailboxId: body.mailboxId,
  keys: body.keys.length,
  redrive: body.redrive,
  split: body.split,
});

export const parseSyncMessage = (body: unknown): ProcessBatch | null => {
  const message = syncMessageSchema.safeParse(body);
  return message.success ? message.data : null;
};

export const describeSyncMessage = (body: ProcessBatch | null): Record<string, unknown> =>
  body === null ? { kind: "Unknown" } : { kind: body.kind, ...batchFields(body) };

export const handleSyncMessage = async (
  env: Env,
  body: ProcessBatch,
  attempts: number,
): Promise<void> => {
  if (attempts > 1 && body.keys.length > 1) {
    await env.SYNC.sendBatch(toSingles(body));
    log.warn("batch split", { ...batchFields(body), attempts });
    return;
  }
  await processBatch(env, body);
};

export const handleDeadLetter = async (
  env: Env,
  body: ProcessBatch | null,
  attempts: number,
  raw: unknown,
): Promise<void> => {
  if (body === null) {
    log.error("dlq dropped", {
      event: "sync.dlq",
      action: "Dropped",
      reason: "unreadable message",
      attempts,
      body: raw,
    });
    return;
  }
  const fields = { event: "sync.dlq", ...batchFields(body), keyList: body.keys, attempts };
  if (body.redrive) {
    log.error("dlq dropped", { ...fields, action: "Dropped", reason: "redrive exhausted" });
    return;
  }
  const redrives = toRedrives(body);
  await env.SYNC.sendBatch(redrives);
  log.warn("dlq redriven", {
    ...fields,
    action: "Redriven",
    reason: "retries exhausted",
    messages: redrives.length,
  });
};
