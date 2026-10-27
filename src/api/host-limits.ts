import type { SqliteLimits } from "@remit/drizzle-service";
import type { QueueFamily } from "../queue/routing";

export const CLOUDFLARE_SQLITE_LIMITS: SqliteLimits = { maxBoundParameters: 100 };

// A body costs about 1 s of CPU and one delivery gets 30 s, so 25 leaves headroom for large messages.
export const BODY_BATCH_SIZE = 25;

export type ConsumerConcurrency = number | "Auto";

export interface ConsumerSettings {
  readonly maxBatchSize: number;
  readonly maxConcurrency: ConsumerConcurrency;
}

export const CONSUMER_SETTINGS = {
  sync: { maxBatchSize: 1, maxConcurrency: 2 },
  body: { maxBatchSize: 1, maxConcurrency: 1 },
  mutation: { maxBatchSize: 10, maxConcurrency: "Auto" },
  smtp: { maxBatchSize: 1, maxConcurrency: "Auto" },
  fanout: { maxBatchSize: 10, maxConcurrency: "Auto" },
} as const satisfies Record<QueueFamily, ConsumerSettings>;
