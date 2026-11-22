import { createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import { describe, expect, it } from "vitest";
import { requireTenant } from "../../src/access";
import type { Env } from "../../src/env";
import { OperatorSettings } from "../../src/operator-settings";
import { recordTenantEmail } from "../../src/tenant-email";

const db = (testEnv as unknown as { DB: D1Database }).DB;

const workerEnv = (email: string): Env =>
  ({ DB: db, ACCESS_DEV_IDENTITY: email }) as unknown as Env;

const operatorSettings = (): OperatorSettings =>
  new OperatorSettings(createExecutionContext(), workerEnv("unused@remit.test"));

const feedTokens = async (accountConfigId: string): Promise<number> => {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM calendar_feed_token WHERE account_config_id = ?")
    .bind(accountConfigId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const addFeedToken = (accountConfigId: string): Promise<D1Result> =>
  db
    .prepare(
      "INSERT INTO calendar_feed_token (feed_token_id, account_config_id, calendar_id, token_hash, created_at, updated_at) VALUES (?, ?, 'calendar', ?, 0, 0)",
    )
    .bind(crypto.randomUUID(), accountConfigId, crypto.randomUUID())
    .run();

describe("tenant email join", () => {
  it("finds the mail tenant of a person admitted by Access", async () => {
    const email = `Person-${crypto.randomUUID()}@remit.test`;
    const admitted = await requireTenant(new Request("http://localhost/api/me"), workerEnv(email));
    if (!admitted.ok) throw new Error(admitted.reason);
    await db
      .prepare(
        "INSERT INTO tenant_key (tenant_id, key_version, wrapped_key, iv) VALUES (?, 1, ?, ?)",
      )
      .bind(admitted.tenant.tenantId, new Uint8Array(32), new Uint8Array(12))
      .run();

    const settings = operatorSettings();
    expect(await settings.hasTenant(email.toLowerCase())).toBe(true);
    expect(await settings.listTenantEmails()).toContain(email.toLowerCase());
    expect(await settings.hasTenant(`stranger-${crypto.randomUUID()}@remit.test`)).toBe(false);
  });

  it("revokes the calendar feed tokens of a disabled person", async () => {
    const subject = crypto.randomUUID();
    const email = `disabled-${subject}@remit.test`;
    const bystander = deriveAccountConfigId(crypto.randomUUID());
    await recordTenantEmail(db, subject, email);
    await addFeedToken(deriveAccountConfigId(subject));
    await addFeedToken(bystander);

    await operatorSettings().revokePersonCredentials(email, true);

    expect(await feedTokens(deriveAccountConfigId(subject))).toBe(0);
    expect(await feedTokens(bystander)).toBe(1);
  });
});
