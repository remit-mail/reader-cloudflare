import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ApiClient, waitFor } from "../.reader/packages/e2e/src/api.js";
import {
  buildClassificationFixtures,
  type ClassificationFixture,
} from "../.reader/packages/e2e/src/classification-fixtures.js";
import {
  imap,
  imapFromStack,
  mintImapUser,
  rejectingSmtpFromStack,
  smtpFromStack,
} from "../.reader/packages/e2e/src/env.js";
import {
  appendMessages,
  listServerSubjects,
  type Message,
  serverFlagsForSubject,
  waitForServerMailbox,
} from "../.reader/packages/e2e/src/imap.js";
import { waitForSettledOutboxRow } from "../.reader/packages/e2e/src/outbox.js";
import {
  readAcceptedEnvelope,
  waitForAcceptedMessage,
} from "../.reader/packages/e2e/src/smtp-sink.js";

const DEV_IDENTITY = "e2e@remit.test";
const RECIPIENT = "sender@remit.test";
const SEARCHED_WORD = "Harbourmaster";

const newsletterFixture = (): ClassificationFixture => {
  const fixture = buildClassificationFixtures().find(
    (candidate) => candidate.expectedCategory === "newsletter",
  );
  if (fixture === undefined) throw new Error("reader has no newsletter classification fixture");
  return fixture;
};
const NEWSLETTER = newsletterFixture();
const NEWSLETTER_SENDER = "writer@letter.test";
const OVERRIDDEN_CATEGORY = "personal";

const SEEDED: Message[] = [
  { subject: `${SEARCHED_WORD} inspection on Friday`, body: "The quay closes at noon." },
  { subject: "Lunch on Thursday?", body: "Shall we try the new place on the corner?" },
  { subject: "Invoice for October", body: "Attached is the invoice for October." },
  NEWSLETTER.message,
];
const TOGGLED_SUBJECT = "Lunch on Thursday?";
const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";
const SEEDED_SUBJECTS = SEEDED.map((message) => message.subject).sort();
const LATE: Message = {
  subject: "Arrived after onboarding",
  body: "Sent once the account existed.",
};
const UNFETCHED: Message = {
  subject: "Opened before its body batch",
  body: "The reading pane fetched this body from IMAP.",
};
const FIRST_SIGHT_POLL_MS = 100;
const SENT_SUBJECT = `Sent from the local Worker ${Date.now()}`;
const REFUSED_SUBJECT = `Refused by the outgoing server ${Date.now()}`;
const REFUSED_RECIPIENT = "nobody@remit.test";
const CORRECTED_RECIPIENT = "corrected@remit.test";
const QUEUE_SETTLE_MS = 8_000;
const CRON = "*/5 * * * *";

const imapUser = mintImapUser();
const api = new ApiClient({ email: DEV_IDENTITY, password: "", token: "dev-identity" });

interface Shared {
  accountId: string;
  inboxId: string;
}

const shared: Shared = { accountId: "", inboxId: "" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const accountIdFor = async (email: string): Promise<string> => {
  const response = await api.request("GET", "/config");
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.accounts))
    throw new Error("GET /config has no accounts");
  const account: unknown = body.accounts.find(
    (entry: unknown) => isRecord(entry) && entry.email === email,
  );
  if (!isRecord(account) || typeof account.accountId !== "string") {
    throw new Error(`no account for ${email} in GET /config`);
  }
  return account.accountId;
};

interface SyncSnapshot {
  readonly syncPhase: string;
  readonly lastSyncAt: number;
  readonly mailboxes: ReadonlyMap<string, number>;
}

const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0);

const syncSnapshot = async (accountId: string): Promise<SyncSnapshot> => {
  const response = await api.request("GET", `/accounts/${accountId}/sync/status`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.mailboxes)) {
    throw new Error(`GET /accounts/${accountId}/sync/status has no mailboxes`);
  }
  const mailboxes = new Map<string, number>();
  for (const entry of body.mailboxes) {
    if (isRecord(entry) && typeof entry.mailboxId === "string") {
      mailboxes.set(entry.mailboxId, numberOf(entry.lastSyncedAt));
    }
  }
  return {
    syncPhase: typeof body.syncPhase === "string" ? body.syncPhase : "",
    lastSyncAt: numberOf(body.lastSyncAt),
    mailboxes,
  };
};

interface Server {
  readonly host: string;
  readonly port: number;
}

const fillServer = async (page: Page, legend: RegExp, server: Server): Promise<void> => {
  const group = page.getByRole("group", { name: legend });
  await group.getByLabel("Host").fill(server.host);
  await group.getByLabel("Port").fill(String(server.port));
  await group.getByLabel("Security").selectOption("none");
};

const plainTextUrlOf = (description: unknown): string => {
  if (!isRecord(description) || !Array.isArray(description.bodyParts)) {
    throw new Error("GET /messages/{messageId} has no bodyParts");
  }
  const part: unknown = description.bodyParts.find(
    (entry: unknown) =>
      isRecord(entry) &&
      typeof entry.mediaType === "string" &&
      typeof entry.mediaSubtype === "string" &&
      `${entry.mediaType}/${entry.mediaSubtype}`.toLowerCase() === "text/plain",
  );
  if (!isRecord(part) || typeof part.contentUrl !== "string") {
    throw new Error("GET /messages/{messageId} has no text/plain part");
  }
  return part.contentUrl;
};

const connectionTestOf = (password: string): Record<string, unknown> => ({
  username: imapUser,
  password,
  imapHost: imapFromStack.host,
  imapPort: imapFromStack.port,
  imapTls: false,
  imapStartTls: false,
  smtpHost: smtpFromStack.host,
  smtpPort: smtpFromStack.port,
  smtpTls: false,
  smtpStartTls: false,
});

const wranglerLog = (): string => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return readFileSync(path, "utf8");
};

const jsonLineOf = (line: string): unknown => JSON.parse(line.slice(line.indexOf("{")));

const schedulerTicksSince = (since: number): Record<string, unknown>[] =>
  wranglerLog()
    .split("\n")
    .filter((line) => line.includes('"scheduler.tick"'))
    .map(jsonLineOf)
    .filter(isRecord)
    .filter((record) => typeof record.time === "string" && Date.parse(record.time) >= since);

const PURGE_EVENTS = new Set(["AccountDataPurge", "FinalizeAccountDataPurge"]);

const purgeConsumesSince = (since: number): Record<string, unknown>[] =>
  wranglerLog()
    .split("\n")
    .filter((line) => line.includes('"queue.consume"'))
    .map(jsonLineOf)
    .filter(isRecord)
    .filter(
      (record) =>
        typeof record.type === "string" &&
        PURGE_EVENTS.has(record.type) &&
        typeof record.time === "string" &&
        Date.parse(record.time) >= since,
    );

const openInbox = async (page: Page): Promise<void> => {
  await page.goto(`/mail/${shared.inboxId}`);
  await expect(page.locator("a[data-message-row]").first()).toBeVisible({ timeout: 30_000 });
};

test.describe.configure({ mode: "serial" });

test.describe("reader on a local Worker", () => {
  test("GET /config carries the local commit as buildCommit", async () => {
    const response = await api.request("GET", "/config");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isRecord(body) && body.buildCommit).toBe(process.env.E2E_COMMIT);
  });

  test("the onboarding wizard adds the synthetic account and syncs it", async ({ page }) => {
    expect(await listServerSubjects(imapUser)).toEqual([]);
    await appendMessages(imapUser, SEEDED);

    await page.goto("/");
    await page.getByRole("button", { name: "Add your first account" }).click();
    await page.getByRole("button", { name: "Continue with IMAP" }).click();
    await page.locator("#onboarding-email").fill(imapUser);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Confirm server settings" })).toBeVisible();
    await fillServer(page, /IMAP/, imapFromStack);
    await fillServer(page, /SMTP/, smtpFromStack);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.locator("#credentials-password").fill(imap.password);
    await page.getByRole("button", { name: "Test connection" }).click();

    const goToInbox = page.getByRole("button", { name: "Go to inbox" });
    await expect(goToInbox).toBeEnabled({ timeout: 60_000 });
    shared.accountId = await accountIdFor(imapUser);
    const mailboxes = await waitFor(
      () => api.listMailboxes(shared.accountId),
      (items) => items.some((mailbox) => mailbox.fullPath === "INBOX"),
      { timeoutMs: 60_000, what: "INBOX from the first sync" },
    );
    shared.inboxId = mailboxes.find((mailbox) => mailbox.fullPath === "INBOX")?.mailboxId ?? "";
    const synced = await waitFor(
      () => api.listThreads(shared.inboxId),
      (threads) => threads.length === SEEDED.length,
      { timeoutMs: 60_000, what: "the seeded messages from the first sync" },
    );
    expect(synced.map((thread) => thread.subject).sort()).toEqual(SEEDED_SUBJECTS);

    await goToInbox.click();
    await expect(page.getByRole("navigation", { name: "Mailboxes", exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a triggered sync brings in mail that arrived after onboarding", async ({ page }) => {
    await waitFor(
      () => api.getSyncStatus(shared.accountId),
      (status) => status.syncPhase === "complete",
      { timeoutMs: 90_000, what: "the first sync to complete" },
    );
    await appendMessages(imapUser, [LATE]);
    await api.triggerSync(shared.accountId);

    const onServer = (await listServerSubjects(imapUser)).sort();
    expect(onServer).toEqual([...SEEDED_SUBJECTS, LATE.subject].sort());
    const synced = await waitFor(
      () => api.listThreads(shared.inboxId),
      (threads) => threads.some((thread) => thread.subject === LATE.subject),
      { timeoutMs: 60_000, what: "the late message in the read model" },
    );
    expect(synced.map((thread) => thread.subject).sort()).toEqual(onServer);

    await openInbox(page);
    for (const subject of onServer) {
      await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
    }
  });

  test("a second GET /config within a minute queues no message sync", async () => {
    const askedAt = Date.now();
    await api.triggerSync(shared.accountId);
    const fresh = await waitFor(
      () => syncSnapshot(shared.accountId),
      (snapshot) =>
        snapshot.syncPhase === "complete" &&
        snapshot.mailboxes.size > 0 &&
        [...snapshot.mailboxes.values()].every((syncedAt) => syncedAt >= askedAt),
      { timeoutMs: 60_000, what: "every mailbox synced by the explicit trigger" },
    );

    const oldest = Math.min(...fresh.mailboxes.values());
    let lastSyncAt = fresh.lastSyncAt;
    let configAt = 0;
    for (const round of ["first", "second"]) {
      configAt = Date.now();
      const config = await api.request("GET", "/config");
      expect(config.status).toBe(200);
      const after = await waitFor(
        () => syncSnapshot(shared.accountId),
        (snapshot) => snapshot.lastSyncAt > lastSyncAt && snapshot.syncPhase === "complete",
        { timeoutMs: 30_000, what: `the mailbox sync the ${round} GET /config queued` },
      );
      lastSyncAt = after.lastSyncAt;
    }
    expect(configAt - oldest).toBeLessThan(60_000);
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));

    expect((await syncSnapshot(shared.accountId)).mailboxes).toEqual(fresh.mailboxes);
  });

  test("a connection test with the right password passes IMAP and SMTP", async () => {
    const response = await api.request("POST", "/accounts/test-connection", {
      ...connectionTestOf(imap.password),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imapSuccess: true, smtpSuccess: true });
  });

  test("a connection test with a wrong password reports an authentication failure", async () => {
    const response = await api.request("POST", "/accounts/test-connection", {
      ...connectionTestOf(`${imap.password}-wrong`),
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ imapSuccess: false });
    expect(isRecord(body) && body.imapError).toMatch(/authentication failed/i);
  });

  test("a scheduler tick scans the synced account and queues no sync for it", async () => {
    const before = await syncSnapshot(shared.accountId);
    const tickedAt = Date.now();
    const response = await fetch(
      `${process.env.E2E_BASE_URL}/__scheduled?cron=${encodeURIComponent(CRON)}`,
    );
    expect(response.status).toBe(200);
    const [tick] = await waitFor(
      async () => schedulerTicksSince(tickedAt),
      (ticks) => ticks.length > 0,
      { timeoutMs: 30_000, what: "a scheduler.tick line in the wrangler log" },
    );
    expect(tick).toMatchObject({ outcome: "Ticked", scanned: 1, enqueued: 0, redriveFailed: 0 });
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));
    expect((await syncSnapshot(shared.accountId)).mailboxes).toEqual(before.mailboxes);
  });

  test("a synced newsletter lands in the brief's Newsletter section", async ({ page }) => {
    const threads = await waitFor(
      () => api.listThreads(shared.inboxId),
      (items) =>
        items.some(
          (thread) =>
            thread.subject === NEWSLETTER.subject &&
            thread.category !== undefined &&
            thread.category !== "uncategorized",
        ),
      { timeoutMs: 60_000, what: "the newsletter classified by body sync" },
    );
    const newsletter = threads.find((thread) => thread.subject === NEWSLETTER.subject);
    expect(newsletter?.category).toBe(NEWSLETTER.expectedCategory);

    await page.goto("/mail/brief");
    const section = page
      .locator("[data-section-header]", { hasText: "Newsletter" })
      .locator("xpath=..");
    await expect(
      section.locator("[data-message-row]", { hasText: NEWSLETTER.subject }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("setting a sender's category relabels that sender's existing messages", async () => {
    const [sender] = (await api.searchAddresses(NEWSLETTER_SENDER)).filter(
      (address) => address.normalizedEmail === NEWSLETTER_SENDER,
    );
    if (sender === undefined) throw new Error(`no address for ${NEWSLETTER_SENDER}`);
    const response = await api.request("PATCH", `/addresses/${sender.addressId}`, {
      flags: { category: { value: OVERRIDDEN_CATEGORY, setAt: Date.now() } },
    });
    expect(response.status).toBe(200);

    const threads = await waitFor(
      () => api.listThreads(shared.inboxId),
      (items) =>
        items.some(
          (thread) =>
            thread.subject === NEWSLETTER.subject && thread.category === OVERRIDDEN_CATEGORY,
        ),
      { timeoutMs: 60_000, what: "the newsletter relabelled by the sender category back-apply" },
    );
    const fromSender = threads.filter((thread) => thread.fromEmail === NEWSLETTER_SENDER);
    expect(fromSender.length).toBeGreaterThan(0);
    expect(fromSender.map((thread) => thread.category)).toEqual(
      fromSender.map(() => OVERRIDDEN_CATEGORY),
    );
  });

  test("opening a seeded message shows its body", async ({ page }) => {
    const [message] = SEEDED;
    if (message === undefined || message.body === undefined) throw new Error("no seeded message");
    await openInbox(page);
    await page.getByText(message.subject, { exact: true }).first().click();
    const article = page.getByRole("article");
    await expect(article.getByRole("heading", { level: 1 })).toHaveText(message.subject, {
      timeout: 30_000,
    });
    await expect(article).toContainText(message.body, { timeout: 30_000 });
  });

  test("opening a message before its body batch lands serves the body", async () => {
    await appendMessages(imapUser, [UNFETCHED]);
    await api.triggerSync(shared.accountId);
    const threads = await waitFor(
      () => api.listThreads(shared.inboxId),
      (items) => items.some((thread) => thread.subject === UNFETCHED.subject),
      { timeoutMs: 60_000, intervalMs: FIRST_SIGHT_POLL_MS, what: "the unfetched message" },
    );
    const thread = threads.find((candidate) => candidate.subject === UNFETCHED.subject);
    if (thread === undefined) throw new Error("matched but not found");

    const described = await api.request("GET", `/messages/${thread.messageId}`);
    expect(described.status).toBe(200);
    const content = await fetch(plainTextUrlOf(await described.json()));
    expect(content.status).toBe(200);
    expect(await content.text()).toContain(UNFETCHED.body);
  });

  test("search finds a seeded subject and nothing else", async ({ page }) => {
    const [match, ...rest] = SEEDED;
    const others = [...rest, LATE, UNFETCHED];
    if (match === undefined) throw new Error("no seeded message");
    await openInbox(page);
    const field = page.getByRole("textbox", { name: "Search mail" });
    await field.fill(SEARCHED_WORD);
    await field.press("Enter");
    for (const other of others) {
      await expect(page.getByText(other.subject, { exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });
    }
    await expect(page.getByText(match.subject, { exact: true }).first()).toBeVisible();
  });

  test("toggling read and star lands on Dovecot", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, TOGGLED_SUBJECT);
    const serverFlags = (accept: (flags: string[]) => boolean, what: string) =>
      waitFor(() => serverFlagsForSubject(imapUser, "INBOX", TOGGLED_SUBJECT), accept, {
        timeoutMs: 60_000,
        what,
      });

    expect(await api.updateMessageFlags(messageId, { isRead: true, isStarred: true })).toEqual({
      messageId,
      isRead: true,
      isStarred: true,
    });
    await serverFlags(
      (flags) => flags.includes(SEEN) && flags.includes(FLAGGED),
      `${SEEN} and ${FLAGGED} on "${TOGGLED_SUBJECT}" in Dovecot`,
    );

    const cleared = await api.request("POST", "/messages/flags", {
      messageIds: [messageId],
      isRead: false,
      isStarred: false,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ successCount: 1, failureCount: 0 });
    await serverFlags(
      (flags) => !flags.includes(SEEN) && !flags.includes(FLAGGED),
      `${SEEN} and ${FLAGGED} cleared from "${TOGGLED_SUBJECT}" in Dovecot`,
    );
  });

  test("a composed message reaches the recipient and the Sent folder", async ({ page }) => {
    await openInbox(page);
    await page.getByRole("button", { name: "Compose", exact: true }).first().click();
    await page.getByPlaceholder("Recipients").fill(RECIPIENT);
    await page.getByPlaceholder("Recipients").press("Enter");
    await page.locator("[data-subject-field]").fill(SENT_SUBJECT);
    await page.getByTestId("compose-body").click();
    await page.keyboard.type("Written in a browser, sent by a local Worker.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const accepted = await waitForAcceptedMessage(SENT_SUBJECT, { timeoutMs: 60_000 });
    const envelope = await readAcceptedEnvelope(accepted.id);
    expect(envelope.from).toBe(imapUser);
    expect(envelope.to).toEqual([RECIPIENT]);
    expect(accepted.raw).toContain("Written in a browser, sent by a local Worker.");

    await waitForServerMailbox(imapUser, "Sent", (subjects) => subjects.includes(SENT_SUBJECT), {
      what: `"${SENT_SUBJECT}" in Sent`,
    });
  });

  test("a refused send settles as failed and goes out once its recipient is corrected", async () => {
    await api.updateAccount(shared.accountId, {
      smtpHost: rejectingSmtpFromStack.host,
      smtpPort: rejectingSmtpFromStack.port,
    });
    const queued = await api.sendMessage({
      accountId: shared.accountId,
      toAddresses: [REFUSED_RECIPIENT],
      subject: REFUSED_SUBJECT,
      textBody: "The refusing lane answers 550 at RCPT TO.",
    });
    const row = await waitForSettledOutboxRow(api, queued.outboxMessageId, "failed", {
      timeoutMs: 60_000,
    });
    expect(row.lastError).toContain("550");
    expect(await listServerSubjects(imapUser, "Sent")).not.toContain(REFUSED_SUBJECT);

    const corrected = await api.request("PATCH", `/outbox/${queued.outboxMessageId}`, {
      toAddresses: [CORRECTED_RECIPIENT],
    });
    expect(corrected.status).toBe(200);
    const resent = await api.request("POST", `/outbox/${queued.outboxMessageId}/send`);
    expect(resent.status).toBe(200);
    await waitForServerMailbox(imapUser, "Sent", (subjects) => subjects.includes(REFUSED_SUBJECT), {
      what: `"${REFUSED_SUBJECT}" in Sent after the corrected send`,
    });
  });

  test("deleting the account purges its mail and takes it off GET /config", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, TOGGLED_SUBJECT);
    const deletedAt = Date.now();
    const deleted = await api.request("DELETE", `/accounts/${shared.accountId}`);
    expect(deleted.status).toBe(200);

    const config: unknown = await (await api.request("GET", "/config")).json();
    expect(isRecord(config) && config.accounts).toEqual([]);
    const sync = await api.request("POST", `/accounts/${shared.accountId}/sync`);
    expect(sync.status).toBe(404);

    const purges = await waitFor(
      async () => purgeConsumesSince(deletedAt),
      (records) =>
        records.filter((record) => record.type === "FinalizeAccountDataPurge").length >= 2,
      { timeoutMs: 60_000, what: "the purge fanout, its subtree batch and its container step" },
    );
    expect(purges.map((record) => record.outcome)).toEqual(purges.map(() => "Acked"));
    const described = await api.request("GET", `/messages/${messageId}`);
    expect(described.status).toBe(404);
  });
});
