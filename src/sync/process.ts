import type { Env } from "../env";
import { log } from "../log";
import type { MailAccount } from "../mail/types";
import { tenantMail } from "../stubs";
import { type ProcessBatch, type SyncMessage, syncMessageSchema } from "./messages";

export const SYNC_QUEUE = "reader-cloudflare-sync";
export const SYNC_DLQ = "reader-cloudflare-sync-dlq";

const REDRIVE_CHUNK = 5;

const processBatch = async (env: Env, body: ProcessBatch, attempts: number): Promise<void> => {
  const started = Date.now();
  const account: MailAccount = {
    tenantId: body.tenantId,
    accountId: body.accountId,
    accountConfigId: body.accountConfigId,
  };
  const outcome = await tenantMail(env, account.tenantId).syncBodies({
    account,
    mailboxId: body.mailboxId,
    messages: body.messages,
    attempts,
  });
  if (!outcome.ok) throw new Error(`bodies ${body.mailboxId}: ${outcome.reason}`);
  const { synced, skipped, failed, bytes } = outcome.value;
  const durationMs = Date.now() - started;
  const count = body.messages.length;
  log.info("batch processed", {
    event: "sync.batch",
    tenantId: account.tenantId,
    accountId: account.accountId,
    mailboxId: body.mailboxId,
    messagesFetched: count,
    messagesStored: synced,
    messagesSkipped: skipped,
    messagesFailed: failed,
    bytes,
    redrive: body.redrive,
    split: body.split,
    durationMs,
    perMessageMs: Math.round(durationMs / count),
  });
  if (failed > 0)
    throw new Error(`${failed} of ${count} bodies in ${body.mailboxId} were not stored`);
};

const toSingles = (body: ProcessBatch): MessageSendRequest<SyncMessage>[] =>
  body.messages.map((message) => ({ body: { ...body, messages: [message], split: true } }));

const toRedrives = (body: ProcessBatch): MessageSendRequest<SyncMessage>[] => {
  const requests: MessageSendRequest<SyncMessage>[] = [];
  for (let index = 0; index < body.messages.length; index += REDRIVE_CHUNK) {
    const messages = body.messages.slice(index, index + REDRIVE_CHUNK);
    requests.push({ body: { ...body, messages, redrive: true, split: false } });
  }
  return requests;
};

const batchFields = (body: ProcessBatch): Record<string, unknown> => ({
  tenantId: body.tenantId,
  accountId: body.accountId,
  mailboxId: body.mailboxId,
  messages: body.messages.length,
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
  if (attempts > 1 && body.messages.length > 1) {
    await env.SYNC.sendBatch(toSingles(body));
    log.warn("batch split", { ...batchFields(body), attempts });
    return;
  }
  await processBatch(env, body, attempts);
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
  const fields = {
    event: "sync.dlq",
    ...batchFields(body),
    uids: body.messages.map((message) => message.uid),
    attempts,
  };
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
