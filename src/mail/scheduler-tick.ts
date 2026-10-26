import type { RemitClient } from "@remit/backend/client";
import type { ProcessContext } from "@remit/imap-worker/process";
import {
  buildAttachmentSweep,
  createEmitEvent,
  DEFAULT_OFFLINE_INTERVAL_MS,
  redriveStrandedPlacements,
  runSchedulerTick,
  type SchedulerTickResult,
} from "@remit/imap-worker/scheduler-tick";

export const TICK_INTERVAL_MS = 5 * 60 * 1000;

export const schedulerTick = (
  client: RemitClient,
  context: ProcessContext,
  now: number,
): Promise<SchedulerTickResult> => {
  const emit = createEmitEvent({
    queues: context.queues,
    mailboxLock: client.mailboxLock,
    metrics: context.metrics,
  });
  return runSchedulerTick({
    accountService: client.account,
    queue: context.queues.mailboxes,
    log: context.log,
    offlineIntervalMs: DEFAULT_OFFLINE_INTERVAL_MS,
    tickIntervalMs: TICK_INTERVAL_MS,
    now,
    sweepAttachments: buildAttachmentSweep(client, context.log),
    redriveStrandedPlacements: (account, tickNow) =>
      redriveStrandedPlacements({ client, emit, log: context.log }, account, tickNow),
  });
};
