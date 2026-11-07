import { expect, test } from "@playwright/test";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendMessages, listServerSubjects } from "../.reader/packages/e2e/src/imap.js";
import { deadLettersOf, mailStoreOf, queueConsumesOf, rowsIn } from "./local-store.js";
import {
  connectImapAccount,
  eraseTenant,
  mintIdentity,
  tenantJson,
  tenantRequest,
} from "./tenant.js";

const IDENTITY = mintIdentity("chaos-race");
const json = tenantJson(IDENTITY);
const request = tenantRequest(IDENTITY);

const SEEDED_COUNT = 300;
const CONCURRENT_SYNCS = 8;
const CONCURRENT_CONFIGS = 4;
const QUEUE_SETTLE_MS = 8_000;

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

test.describe("chaos: overlapping syncs", () => {
  test.afterAll(() => eraseTenant(json, IDENTITY));

  test("concurrent sync triggers land exactly the server's messages", async () => {
    test.setTimeout(600_000);
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
        subject: `Race ${stamp} message ${String(index).padStart(3, "0")}`,
        body: `Seeded message ${index} for the overlapping sync race.`,
      })),
    );
    const onServer = (await listServerSubjects(imapUser)).sort();
    expect(onServer).toHaveLength(SEEDED_COUNT);

    const firedAt = Date.now();
    const responses = await Promise.all([
      ...Array.from({ length: CONCURRENT_SYNCS }, () =>
        request("POST", `/accounts/${accountId}/sync`),
      ),
      ...Array.from({ length: CONCURRENT_CONFIGS }, () => request("GET", "/config")),
    ]);
    const statuses = responses.map((response) => response.status);
    console.log(`chaos-sync-race statuses: ${JSON.stringify(statuses)}`);
    expect(statuses.every((status) => status >= 200 && status < 300)).toBe(true);

    const threads = await waitFor(
      () => allThreads(inboxId),
      (listed) => listed.length >= SEEDED_COUNT,
      { timeoutMs: 300_000, what: `${SEEDED_COUNT} threads in the INBOX` },
    );
    await waitFor(
      () => syncPhaseOf(accountId),
      (phase) => phase === "complete",
      { timeoutMs: 120_000, what: "the sync phase to settle on complete" },
    );
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));

    const settled = await allThreads(inboxId);
    expect(settled.length).toBeGreaterThanOrEqual(threads.length);
    expect(new Set(settled.map((thread) => thread.threadId)).size).toBe(settled.length);
    expect(settled.map((thread) => thread.subject ?? "").sort()).toEqual(onServer);
    expect(await syncPhaseOf(accountId)).toBe("complete");

    const [counts] = rowsIn(
      mailStoreOf(accountId),
      "select count(*) as messages, count(distinct uid) as uids from message where mailbox_id = ?",
      inboxId,
    );
    expect(counts).toEqual({ messages: SEEDED_COUNT, uids: SEEDED_COUNT });

    const syncRuns = queueConsumesOf(IDENTITY, firedAt).filter(
      (consume) => consume.type === "SYNC_MESSAGES",
    );
    const overlapping = syncRuns.filter((run, index) =>
      syncRuns.some(
        (other, at) =>
          at !== index && other.startedAt < run.endedAt && run.startedAt < other.endedAt,
      ),
    );
    console.log(
      `chaos-sync-race runs: ${syncRuns.length} SYNC_MESSAGES consumes, ${overlapping.length} overlapping, outcomes ${JSON.stringify(syncRuns.map((run) => run.outcome))}`,
    );
    // Miniflare flushes a queue one batch at a time and ignores max_concurrency, so
    // locally the triggers repeat the INBOX sync back to back; production runs two at once.
    expect(syncRuns.length).toBeGreaterThanOrEqual(2);
    expect(syncRuns.every((run) => run.outcome === "Acked")).toBe(true);
    expect(deadLettersOf(IDENTITY)).toEqual([]);
  });
});
