import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
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
  readMimeShape,
  readMimeShapeOfRaw,
  serverFlagsForSubject,
  serverRawSourceForSubject,
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
const DELETED_SUBJECT = "Invoice for October";
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
const ATTACHED_SUBJECT = `Sent with an attachment ${Date.now()}`;
const ATTACHMENT = {
  name: "tide-table.txt",
  mimeType: "text/plain",
  content: "High water at 06:12 and 18:40.",
};
const REFUSED_SUBJECT = `Refused by the outgoing server ${Date.now()}`;
const REFUSED_RECIPIENT = "nobody@remit.test";
const CORRECTED_RECIPIENT = "corrected@remit.test";
const REPORTED: Message = {
  subject: "Reported as spam, then restored",
  from: "Spammer <reported@spam.test>",
  body: "Reported, then marked not spam once it reached Junk.",
};
const UNDONE: Message = {
  subject: "Reported as spam and undone at once",
  from: "Spammer <undone@spam.test>",
  body: "Marked not spam before the move to Junk was delivered.",
};
const FILTERED: Message = {
  subject: "Receipt 4471 from the chandlery",
  body: "Rope, two shackles and a fender.",
};
const FILTERED_WORD = "chandlery";
const COPIED: Message = {
  subject: "Copied to Archive, then deleted from INBOX",
  body: "The Archive copy keeps this body.",
};
const DRAFT_SUBJECT = `A draft to discard ${Date.now()}`;
const TERMINAL_JOB_STATES = new Set(["Complete", "Failed"]);
const QUEUE_SETTLE_MS = 8_000;
const CRON = "*/5 * * * *";

const imapUser = mintImapUser();
const api = new ApiClient({ email: DEV_IDENTITY, password: "", token: "dev-identity" });

interface Shared {
  accountId: string;
  inboxId: string;
  exportUrl: string;
  deletedMessageId: string;
}

const shared: Shared = { accountId: "", inboxId: "", exportUrl: "", deletedMessageId: "" };

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

const wranglerLogPath = (): string => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return path;
};

const wranglerLog = (): string => readFileSync(wranglerLogPath(), "utf8");

const countSchema = z.object({ rows: z.number() });

const localStoreOf = (plugin: string, objectClass: string): string => {
  const dir = join(dirname(wranglerLogPath()), "v3", plugin, objectClass);
  const [file] = readdirSync(dir).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (file === undefined) throw new Error(`no local ${plugin} store under ${dir}`);
  return join(dir, file);
};

const countIn = (path: string, query: string, ...params: string[]): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return countSchema.parse(db.prepare(query).get(...params)).rows;
  } finally {
    db.close();
  }
};

const d1RowsIn = (table: string): number =>
  countIn(
    localStoreOf("d1", "miniflare-D1DatabaseObject"),
    `select count(*) as rows from ${table}`,
  );

const r2ObjectsOf = (messageId: string): number =>
  countIn(
    localStoreOf("r2", "miniflare-R2BucketObject"),
    "select count(*) as rows from _mf_objects where instr(key, ?) > 0",
    `/messages/${messageId}/`,
  );

const storedObjectsOf = (messageId: string, what: string): Promise<number> =>
  waitFor(
    async () => r2ObjectsOf(messageId),
    (count) => count > 0,
    { timeoutMs: 60_000, what },
  );

const jsonLineOf = (line: string): unknown =>
  JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));

const schedulerTicksSince = (since: number): Record<string, unknown>[] =>
  wranglerLog()
    .split("\n")
    .filter((line) => line.includes('"scheduler.tick"'))
    .map(jsonLineOf)
    .filter(isRecord)
    .filter((record) => typeof record.time === "string" && Date.parse(record.time) >= since);

const PURGE_EVENTS = new Set(["AccountDataPurge", "FinalizeAccountDataPurge"]);

const consumesSince = (types: ReadonlySet<string>, since: number): Record<string, unknown>[] =>
  wranglerLog()
    .split("\n")
    .filter((line) => line.includes('"queue.consume"'))
    .map(jsonLineOf)
    .filter(isRecord)
    .filter(
      (record) =>
        typeof record.type === "string" &&
        types.has(record.type) &&
        typeof record.time === "string" &&
        Date.parse(record.time) >= since,
    );

const queuedExportSchema = z.object({ exportId: z.string() });
const exportSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("Ready"), downloadUrl: z.string() }),
  z.object({ state: z.enum(["Pending", "Processing", "Failed"]) }),
]);

const parsedBody = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await response.json());

const archiveMailboxId = async (): Promise<string> => {
  const archive = (await api.listMailboxes(shared.accountId)).find(
    (mailbox) => mailbox.fullPath === "Archive",
  );
  if (archive === undefined) throw new Error("no Archive mailbox in the read model");
  return archive.mailboxId;
};

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

  test("a composed attachment reaches the recipient and the Sent copy", async ({ page }) => {
    await openInbox(page);
    await page.getByRole("button", { name: "Compose", exact: true }).first().click();
    await page.getByPlaceholder("Recipients").fill(RECIPIENT);
    await page.getByPlaceholder("Recipients").press("Enter");
    await page.locator("[data-subject-field]").fill(ATTACHED_SUBJECT);
    await page.getByTestId("compose-body").click();
    await page.keyboard.type("The tide table is attached.");
    await page.getByTestId("compose-attach-input").setInputFiles({
      name: ATTACHMENT.name,
      mimeType: ATTACHMENT.mimeType,
      buffer: Buffer.from(ATTACHMENT.content),
    });
    await expect(
      page.locator("[data-testid=compose-attachment][data-state=attached]", {
        hasText: ATTACHMENT.name,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const carried = expect.arrayContaining([
      expect.objectContaining({ filename: ATTACHMENT.name, content: ATTACHMENT.content }),
    ]);
    const accepted = await waitForAcceptedMessage(ATTACHED_SUBJECT, { timeoutMs: 60_000 });
    expect((await readMimeShapeOfRaw(accepted.raw)).parts).toEqual(carried);

    await waitForServerMailbox(
      imapUser,
      "Sent",
      (subjects) => subjects.includes(ATTACHED_SUBJECT),
      {
        what: `"${ATTACHED_SUBJECT}" in Sent`,
      },
    );
    expect((await readMimeShape(imapUser, "Sent", ATTACHED_SUBJECT))?.parts).toEqual(carried);
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

  test("deleting a message moves it to Trash on Dovecot", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, DELETED_SUBJECT);
    await storedObjectsOf(messageId, `the body of "${DELETED_SUBJECT}" in R2`);
    expect(await api.deleteMessages([messageId])).toEqual({ successCount: 1, failureCount: 0 });

    await waitForServerMailbox(
      imapUser,
      "INBOX",
      (subjects) => !subjects.includes(DELETED_SUBJECT),
      {
        what: `"${DELETED_SUBJECT}" gone from INBOX`,
      },
    );
    await waitForServerMailbox(
      imapUser,
      "Trash",
      (subjects) => subjects.includes(DELETED_SUBJECT),
      {
        what: `"${DELETED_SUBJECT}" in Trash`,
      },
    );
    shared.deletedMessageId = messageId;
  });

  test("moving a message lands it in the destination mailbox on Dovecot", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, LATE.subject);
    expect(await api.moveMessages([messageId], await archiveMailboxId())).toEqual({
      successCount: 1,
      failureCount: 0,
    });

    await waitForServerMailbox(imapUser, "Archive", (subjects) => subjects.includes(LATE.subject), {
      what: `"${LATE.subject}" in Archive`,
    });
    expect(await listServerSubjects(imapUser, "INBOX")).not.toContain(LATE.subject);
  });

  test("reporting spam lands the message in Junk on Dovecot and not spam restores it", async () => {
    await appendMessages(imapUser, [REPORTED, UNDONE]);
    await api.triggerSync(shared.accountId);
    const messageId = await api.messageIdForSubject(shared.inboxId, REPORTED.subject);
    await api.messageIdForSubject(shared.inboxId, UNDONE.subject);

    expect(await api.reportSpam([messageId])).toEqual({ successCount: 1, failureCount: 0 });
    await waitForServerMailbox(
      imapUser,
      "Junk",
      (subjects) => subjects.includes(REPORTED.subject),
      { what: `"${REPORTED.subject}" in Junk` },
    );
    expect(await listServerSubjects(imapUser, "INBOX")).not.toContain(REPORTED.subject);

    expect(await api.notSpam([messageId])).toEqual({ successCount: 1, failureCount: 0 });
    await waitForServerMailbox(
      imapUser,
      "INBOX",
      (subjects) => subjects.includes(REPORTED.subject),
      { what: `"${REPORTED.subject}" back in INBOX` },
    );
    expect(await listServerSubjects(imapUser, "Junk")).not.toContain(REPORTED.subject);
  });

  test("marking a message not spam right after reporting it leaves it in INBOX on Dovecot", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, UNDONE.subject);

    expect(await api.reportSpam([messageId])).toEqual({ successCount: 1, failureCount: 0 });
    expect(await api.notSpam([messageId])).toEqual({ successCount: 1, failureCount: 0 });

    await waitForServerMailbox(imapUser, "INBOX", (subjects) => subjects.includes(UNDONE.subject), {
      what: `"${UNDONE.subject}" in INBOX after the undo`,
    });
    await waitForServerMailbox(imapUser, "Junk", (subjects) => !subjects.includes(UNDONE.subject), {
      what: `"${UNDONE.subject}" not in Junk after the undo`,
    });
  });

  test("emptying Trash expunges it on Dovecot", async () => {
    expect(await listServerSubjects(imapUser, "Trash")).toContain(DELETED_SUBJECT);
    const emptied = await api.emptyTrash(shared.accountId);
    expect(emptied.deletedCount).toBeGreaterThan(0);
    await waitForServerMailbox(imapUser, "Trash", (subjects) => subjects.length === 0, {
      what: "an empty Trash",
    });
    await waitFor(
      async () => r2ObjectsOf(shared.deletedMessageId),
      (count) => count === 0,
      { timeoutMs: 60_000, what: `the body of "${DELETED_SUBJECT}" off R2` },
    );
  });

  test("a copy keeps its body in R2 after its original is deleted for good", async () => {
    await appendMessages(imapUser, [COPIED]);
    await api.triggerSync(shared.accountId);
    const originalId = await api.messageIdForSubject(shared.inboxId, COPIED.subject);
    const stored = await storedObjectsOf(originalId, `the body of "${COPIED.subject}" in R2`);
    const archiveId = await archiveMailboxId();
    const copied = await api.request("POST", "/messages/copy", {
      messageIds: [originalId],
      destinationMailboxId: archiveId,
    });
    expect(copied.status).toBe(200);
    expect(await copied.json()).toEqual({ successCount: 1, failureCount: 0 });
    await waitForServerMailbox(
      imapUser,
      "Archive",
      (subjects) => subjects.includes(COPIED.subject),
      {
        what: `"${COPIED.subject}" copied into Archive`,
      },
    );
    const copyId = await api.messageIdForSubject(archiveId, COPIED.subject);
    const onServer = await serverRawSourceForSubject(imapUser, "Archive", COPIED.subject);
    expect(onServer).toContain(COPIED.body);
    expect(await api.getRawMessage(copyId)).toBe(onServer);

    expect(await api.deleteMessages([originalId])).toEqual({ successCount: 1, failureCount: 0 });
    await waitForServerMailbox(imapUser, "Trash", (subjects) => subjects.includes(COPIED.subject), {
      what: `"${COPIED.subject}" in Trash`,
    });
    expect((await api.emptyTrash(shared.accountId)).deletedCount).toBeGreaterThan(0);
    await waitForServerMailbox(imapUser, "Trash", (subjects) => subjects.length === 0, {
      what: "an empty Trash",
    });
    await waitFor(
      async () => (await api.request("GET", `/messages/${originalId}`)).status,
      (status) => status === 404,
      { timeoutMs: 60_000, what: `the original "${COPIED.subject}" gone from the read model` },
    );
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));

    expect(r2ObjectsOf(originalId)).toBe(stored);
    expect(await api.getRawMessage(copyId)).toBe(onServer);
  });

  test("the raw source of a message is what Dovecot holds", async () => {
    const messageId = await api.messageIdForSubject(shared.inboxId, TOGGLED_SUBJECT);
    const raw = await api.getRawMessage(messageId);
    const onServer = await serverRawSourceForSubject(imapUser, "INBOX", TOGGLED_SUBJECT);
    expect(onServer).not.toBeNull();
    expect(raw).toBe(onServer);
  });

  test("a discarded draft is gone from the outbox", async () => {
    const { outboxMessageId } = await api.createDraft({
      accountId: shared.accountId,
      toAddresses: [RECIPIENT],
      subject: DRAFT_SUBJECT,
      textBody: "Never sent.",
    });

    const deleted = await api.request("DELETE", `/outbox/${outboxMessageId}`);
    expect(deleted.status).toBe(204);
    await expect(api.getOutboxMessage(outboxMessageId)).rejects.toThrow(/ 404 /);
  });

  test("an organize job moves matching mail on Dovecot and completes", async () => {
    const [harbour] = SEEDED;
    if (harbour === undefined) throw new Error("no seeded message");
    const { organizeJobId } = await api.createOrganizeJob(shared.accountId, {
      literalClauses: [{ field: "Subject", value: SEARCHED_WORD }],
      actionMailboxId: await archiveMailboxId(),
    });

    const job = await waitFor(
      () => api.getOrganizeJob(shared.accountId, organizeJobId),
      (body) => TERMINAL_JOB_STATES.has(body.state),
      { timeoutMs: 60_000, what: "the organize job in a terminal state" },
    );
    expect(job).toMatchObject({ state: "Complete", matchedCount: 1, appliedCount: 1 });
    await waitForServerMailbox(
      imapUser,
      "Archive",
      (subjects) => subjects.includes(harbour.subject),
      { what: `"${harbour.subject}" in Archive` },
    );
    expect(await listServerSubjects(imapUser, "INBOX")).not.toContain(harbour.subject);
  });

  test("a new filter moves mail that arrives after it on Dovecot", async () => {
    const created = await api.createFilter(shared.accountId, {
      name: "Chandlery receipts",
      scope: "Standing",
      literalClauses: [{ field: "Subject", value: FILTERED_WORD }],
      actionMailboxId: await archiveMailboxId(),
    });
    expect(created).toMatchObject({ state: "Active", disabledReason: "None" });

    await appendMessages(imapUser, [FILTERED]);
    await api.triggerSync(shared.accountId);
    await waitForServerMailbox(
      imapUser,
      "Archive",
      (subjects) => subjects.includes(FILTERED.subject),
      { what: `"${FILTERED.subject}" filed into Archive` },
    );
    expect(await listServerSubjects(imapUser, "INBOX")).not.toContain(FILTERED.subject);
  });

  test("an export downloads as a zip that holds a synced message", async () => {
    const created = await api.request("POST", "/me/export");
    expect(created.status).toBe(202);
    const { exportId } = await parsedBody(created, queuedExportSchema);

    const settled = await waitFor(
      async () => parsedBody(await api.request("GET", `/me/export/${exportId}`), exportSchema),
      (body) => body.state === "Ready" || body.state === "Failed",
      { timeoutMs: 60_000, what: "the export to settle" },
    );
    if (settled.state !== "Ready") throw new Error(`the export settled as ${settled.state}`);

    const download = await fetch(settled.downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    const inbox = Object.entries(unzipSync(new Uint8Array(await download.arrayBuffer())))
      .filter(([name]) => name.includes("/INBOX/") && name.endsWith(".eml"))
      .map(([, content]) => strFromU8(content));
    expect(inbox.some((eml) => eml.includes(`Subject: ${TOGGLED_SUBJECT}`))).toBe(true);
    shared.exportUrl = settled.downloadUrl;
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
      async () => consumesSince(PURGE_EVENTS, deletedAt),
      (records) =>
        records.filter((record) => record.type === "FinalizeAccountDataPurge").length >= 2,
      { timeoutMs: 60_000, what: "the purge fanout, its subtree batch and its container step" },
    );
    expect(purges.map((record) => record.outcome)).toEqual(purges.map(() => "Acked"));
    const described = await api.request("GET", `/messages/${messageId}`);
    expect(described.status).toBe(404);
  });

  test("deleting me erases the tenant, its filters and its export archives", async () => {
    expect((await fetch(shared.exportUrl)).status).toBe(200);
    expect(d1RowsIn("filter")).toBeGreaterThan(0);
    expect(d1RowsIn("tenant_key")).toBeGreaterThan(0);
    expect(d1RowsIn("tenant_account_config")).toBeGreaterThan(0);
    const deletedAt = Date.now();
    const deleted = await api.request("DELETE", "/me", { confirmEmail: DEV_IDENTITY });
    expect(deleted.status).toBe(202);

    const consumed = await waitFor(
      async () => consumesSince(new Set(["AccountDelete", "FinalizeAccountDelete"]), deletedAt),
      (records) => records.some((record) => record.type === "FinalizeAccountDelete"),
      { timeoutMs: 60_000, what: "the AccountDelete fanout and its finalize step" },
    );
    expect(consumed.map((record) => [record.type, record.outcome])).toEqual([
      ["AccountDelete", "Acked"],
      ["FinalizeAccountDelete", "Acked"],
    ]);
    expect((await fetch(shared.exportUrl)).status).toBe(404);
    expect(d1RowsIn("filter")).toBe(0);
    expect(d1RowsIn("account_config")).toBe(0);
    expect(d1RowsIn("tenant_key")).toBe(0);
    expect(d1RowsIn("tenant_account_config")).toBe(0);

    const tickedAt = Date.now();
    const tick = await fetch(
      `${process.env.E2E_BASE_URL}/__scheduled?cron=${encodeURIComponent(CRON)}`,
    );
    expect(tick.status).toBe(200);
    await new Promise((settle) => setTimeout(settle, QUEUE_SETTLE_MS));
    expect(schedulerTicksSince(tickedAt)).toEqual([]);
  });
});
