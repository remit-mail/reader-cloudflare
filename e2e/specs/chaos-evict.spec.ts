import { expect, test } from "@playwright/test";
import { z } from "zod";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendMessages, listServerSubjects } from "../.reader/packages/e2e/src/imap.js";
import { deadLettersOf, mailStoreOf, rowsIn } from "./local-store.js";
import { connectImapAccount, eraseTenant, mintIdentity, tenantJson } from "./tenant.js";

const IDENTITY = mintIdentity("chaos-evict");
const json = tenantJson(IDENTITY);

const SEEDED_COUNT = 2_000;
const QUEUE_SETTLE_MS = 8_000;

const requiredPort = (name: string): number => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; run \`npm run e2e\``);
  return Number(value);
};

const harness = `http://127.0.0.1:${requiredPort("E2E_HARNESS_CONTROL_PORT")}`;

const restartSchema = z.object({ restartedInMs: z.number() });

const restartWrangler = async (): Promise<number> => {
  const response = await fetch(`${harness}/wrangler/restart`, { method: "POST" });
  if (!response.ok) throw new Error(`restart failed: ${response.status} ${await response.text()}`);
  return restartSchema.parse(await response.json()).restartedInMs;
};

interface ListedThread {
  readonly threadId: string;
  readonly subject?: string;
}

const allThreads = async (mailboxId: string): Promise<ListedThread[]> => {
  const threads: ListedThread[] = [];
  let continuationToken: string | undefined;
  do {
    const params = new URLSearchParams();
    if (continuationToken !== undefined) params.set("continuationToken", continuationToken);
    const page = await json<{ items?: ListedThread[]; continuationToken?: string }>(
      "GET",
      `/mailboxes/${mailboxId}/threads?${params}`,
    );
    threads.push(...(page.items ?? []));
    continuationToken = page.continuationToken;
  } while (continuationToken !== undefined);
  return threads;
};

const syncPhaseOf = (accountId: string): Promise<string> =>
  json<{ syncPhase?: string }>("GET", `/accounts/${accountId}/sync/status`).then(
    (status) => status.syncPhase ?? "",
  );

const storedMessages = (accountId: string, mailboxId: string): number => {
  const [row] = rowsIn(
    mailStoreOf(accountId),
    "select count(*) as messages from message where mailbox_id = ?",
    mailboxId,
  );
  return Number(row?.messages ?? 0);
};

// Miniflare keeps queued messages in memory, so a restart drops the next-batch
// events a production queue would still deliver; their pending markers then
// hold off a re-emit for that mailbox until they lapse, and a trigger repeats.
const syncUntilSettled = async (accountId: string, inboxId: string): Promise<void> => {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    await json("POST", `/accounts/${accountId}/sync`);
    const settled = await waitFor(
      () => allThreads(inboxId),
      (listed) => listed.length >= SEEDED_COUNT,
      { timeoutMs: 30_000, intervalMs: 2_000, what: `${SEEDED_COUNT} threads in the INBOX` },
    ).then(
      () => true,
      () => false,
    );
    if (settled) return;
  }
  throw new Error(`the INBOX never reached ${SEEDED_COUNT} threads after the restart`);
};

test.describe("chaos: durable object evicted mid-sync", () => {
  test.afterAll(() => eraseTenant(json, IDENTITY));

  test("the sync after a restart lands exactly the server's messages", async () => {
    test.setTimeout(900_000);
    const { accountId, imapUser } = await connectImapAccount(json);
    await waitFor(
      () => syncPhaseOf(accountId),
      (phase) => phase === "complete",
      { timeoutMs: 90_000, what: "the onboarding sync to complete" },
    );
    const mailboxes = await json<{ items?: { mailboxId: string; fullPath: string }[] }>(
      "GET",
      `/accounts/${accountId}/mailboxes`,
    );
    const inboxId = mailboxes.items?.find((mailbox) => mailbox.fullPath === "INBOX")?.mailboxId;
    if (inboxId === undefined) throw new Error("the account has no INBOX");

    const stamp = Date.now();
    await appendMessages(
      imapUser,
      Array.from({ length: SEEDED_COUNT }, (_, index) => ({
        subject: `Evict ${stamp} message ${String(index).padStart(4, "0")}`,
        body: `Seeded message ${index} for the eviction mid-sync.`,
      })),
    );
    const onServer = (await listServerSubjects(imapUser)).sort();
    expect(onServer).toHaveLength(SEEDED_COUNT);

    await json("POST", `/accounts/${accountId}/sync`);
    const storedAtEvict = await waitFor(
      async () => storedMessages(accountId, inboxId),
      (stored) => stored > 0,
      { timeoutMs: 120_000, intervalMs: 100, what: "the sync to store its first messages" },
    );
    expect(storedAtEvict).toBeLessThan(SEEDED_COUNT);
    const restartedInMs = await restartWrangler();
    console.log(
      `chaos-evict: restarted at ${storedAtEvict}/${SEEDED_COUNT} stored in ${restartedInMs}ms`,
    );

    const resumedAt = Date.now();
    await syncUntilSettled(accountId, inboxId);
    await waitFor(
      () => syncPhaseOf(accountId),
      (phase) => phase === "complete",
      { timeoutMs: 120_000, what: "the sync phase to settle on complete" },
    );
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));
    console.log(`chaos-evict: next sync settled in ${Date.now() - resumedAt}ms`);

    const settled = await allThreads(inboxId);
    expect(new Set(settled.map((thread) => thread.threadId)).size).toBe(settled.length);
    expect(settled.map((thread) => thread.subject ?? "").sort()).toEqual(onServer);
    expect(await syncPhaseOf(accountId)).toBe("complete");

    const store = mailStoreOf(accountId);
    const [counts] = rowsIn(
      store,
      "select count(*) as messages, count(distinct uid) as uids from message where mailbox_id = ?",
      inboxId,
    );
    expect(counts).toEqual({ messages: SEEDED_COUNT, uids: SEEDED_COUNT });
    expect(
      rowsIn(
        store,
        "select full_path, sync_status, cursor_state from mailbox where account_id = ? and (sync_status != 'synced' or cursor_state != 'normal')",
        accountId,
      ),
    ).toEqual([]);
    expect(deadLettersOf(IDENTITY)).toEqual([]);
  });
});
