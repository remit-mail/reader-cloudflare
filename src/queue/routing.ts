import type { RemitClientDeps } from "@remit/backend/create-remit-client";
import type { WorkerEvent } from "@remit/imap-worker/process";
import { z } from "zod";

type ClientQueues = RemitClientDeps["queues"];

export type QueueName = keyof ClientQueues;

export type EventOn<Q extends QueueName> = Parameters<ClientQueues[Q]["send"]>[0]["body"];

export type ReaderEvent = EventOn<QueueName> | WorkerEvent;

export type ReaderEventType = ReaderEvent["type"];

export type QueueFamily = "sync" | "mutation" | "smtp" | "fanout";

export type ConsumedFamily = Exclude<QueueFamily, "sync">;

export const FAMILY_OF = {
  SYNC_MAILBOXES: "sync",
  SYNC_MESSAGES: "sync",
  SYNC_MESSAGE_BODY: "sync",
  FLAG_PUSH: "mutation",
  PLACEMENT_MOVE_PUSH: "mutation",
  MAILBOX_CREATE: "mutation",
  MAILBOX_RENAME: "mutation",
  MAILBOX_DELETE: "mutation",
  MESSAGE_MOVE: "mutation",
  MESSAGE_DELETE: "mutation",
  MESSAGE_COPY: "mutation",
  EMPTY_TRASH: "mutation",
  APPEND_SENT_MESSAGE: "mutation",
  DELETE_ACCOUNT_OBJECTS: "mutation",
  SEND_MESSAGE: "smtp",
  AccountDelete: "fanout",
  AccountDataPurge: "fanout",
  AccountExport: "fanout",
  OrganizeJob: "fanout",
  SenderCategoryBackApply: "fanout",
} as const satisfies Record<ReaderEventType, QueueFamily>;

export const MAX_RETRIES = {
  sync: 3,
  mutation: 2,
  smtp: 2,
  fanout: 2,
} as const satisfies Record<QueueFamily, number>;

export const attemptsOn = (family: QueueFamily): number => MAX_RETRIES[family] + 1;

export const CONSUMED_QUEUES = {
  "reader-cloudflare-mutation": "mutation",
  "reader-cloudflare-smtp": "smtp",
  "reader-cloudflare-fanout": "fanout",
} as const satisfies Record<string, ConsumedFamily>;

export type ConsumedQueue = keyof typeof CONSUMED_QUEUES;

export const SHARED_DLQ = "reader-cloudflare-dlq";

export const isConsumedQueue = (queue: string): queue is ConsumedQueue =>
  Object.hasOwn(CONSUMED_QUEUES, queue);

export interface QueueEnvelope {
  readonly v: 1;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly event: ReaderEvent;
}

export interface QueueStamp {
  readonly tenantId: string;
  readonly correlationId: string;
}

export const envelopeOf = (stamp: QueueStamp, event: ReaderEvent): QueueEnvelope => ({
  v: 1,
  tenantId: stamp.tenantId,
  correlationId: stamp.correlationId,
  event,
});

const envelopeSchema = z.object({
  v: z.literal(1),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  event: z.object({ type: z.string() }).passthrough(),
});

const isReaderEvent = (event: { readonly type: string }): event is ReaderEvent =>
  Object.hasOwn(FAMILY_OF, event.type);

export type ParsedEnvelope =
  | { readonly ok: true; readonly envelope: QueueEnvelope }
  | { readonly ok: false; readonly reason: string };

export const parseEnvelope = (body: unknown): ParsedEnvelope => {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  const { event } = parsed.data;
  if (!isReaderEvent(event)) return { ok: false, reason: `unknown event type ${event.type}` };
  return { ok: true, envelope: { ...parsed.data, event } };
};
