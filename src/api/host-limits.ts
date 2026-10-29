import type { SqliteLimits } from "@remit/drizzle-service";
import type { QueueFamily } from "../queue/routing";

export const CLOUDFLARE_SQLITE_LIMITS: SqliteLimits = { maxBoundParameters: 100 };

// Workers Paid lets one invocation run up to 5 minutes of CPU; an export compresses a whole mailbox in one.
export const CPU_MS_PER_INVOCATION = 300_000;

// A body costs about 1 s of CPU, so 25 per job leaves headroom for large messages.
export const BODY_BATCH_SIZE = 25;

// An isolate has 128 MB and an in-flight body costs about 3-4x its size while it is parsed.
export const BODY_PROCESS_CONCURRENCY = 4;
export const BODY_PROCESS_BYTES_IN_FLIGHT = 32 * 1024 * 1024;

// An invocation holds at most 6 open connections, R2 calls included; the IMAP socket takes one and a queue send another.
export const MESSAGE_OBJECT_DELETE_CONCURRENCY = 4;

export type ConsumerConcurrency = number | "Auto";

export interface ConsumerSettings {
  readonly maxBatchSize: number;
  readonly maxBatchTimeoutSeconds: number;
  readonly maxConcurrency: ConsumerConcurrency;
}

export const CONSUMER_SETTINGS = {
  sync: { maxBatchSize: 1, maxBatchTimeoutSeconds: 0, maxConcurrency: 2 },
  body: { maxBatchSize: 1, maxBatchTimeoutSeconds: 0, maxConcurrency: 1 },
  mutation: { maxBatchSize: 10, maxBatchTimeoutSeconds: 0, maxConcurrency: "Auto" },
  smtp: { maxBatchSize: 1, maxBatchTimeoutSeconds: 0, maxConcurrency: "Auto" },
  fanout: { maxBatchSize: 10, maxBatchTimeoutSeconds: 0, maxConcurrency: "Auto" },
} as const satisfies Record<QueueFamily, ConsumerSettings>;
