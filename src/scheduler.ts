import type { SchedulerTickResult } from "@remit/imap-worker/scheduler-tick";
import { openAppDb } from "./db/client";
import { tenantKeys } from "./db/schema";
import type { Env } from "./env";
import { errorKindOf, messageOf } from "./error-kind";
import { log, withLogContext } from "./log";
import { tenantMail } from "./stubs";

const tenantsOf = async (env: Env): Promise<readonly string[]> => {
  const rows = await openAppDb(env.DB)
    .selectDistinct({ tenantId: tenantKeys.tenantId })
    .from(tenantKeys);
  return rows.map((row) => row.tenantId);
};

const ticked = (durationMs: number, result: SchedulerTickResult): void =>
  log.info("scheduler tick", { event: "scheduler.tick", outcome: "Ticked", durationMs, ...result });

const failed = (durationMs: number, error: unknown): void =>
  log.error("scheduler tick failed", {
    event: "scheduler.tick",
    outcome: "Failed",
    durationMs,
    errorKind: errorKindOf(error),
    error: messageOf(error),
  });

const tickTenant = (env: Env, tenantId: string, now: number): Promise<void> => {
  const correlationId = crypto.randomUUID();
  return withLogContext({ correlationId, tenantId }, () => {
    const started = Date.now();
    return tenantMail(env, tenantId)
      .schedulerTick(tenantId, now, correlationId)
      .then(
        (result) => ticked(Date.now() - started, result),
        (error: unknown) => failed(Date.now() - started, error),
      );
  });
};

export const tickEveryTenant = async (env: Env, now: number): Promise<void> => {
  for (const tenantId of await tenantsOf(env)) await tickTenant(env, tenantId, now);
};
