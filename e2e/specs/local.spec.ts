import { expect, type Page, test } from "@playwright/test";
import { ApiClient, waitFor } from "../.reader/packages/e2e/src/api.js";
import {
  imap,
  imapFromStack,
  mintImapUser,
  smtpFromStack,
} from "../.reader/packages/e2e/src/env.js";
import {
  appendMessages,
  listServerSubjects,
  type Message,
  waitForServerMailbox,
} from "../.reader/packages/e2e/src/imap.js";
import {
  readAcceptedEnvelope,
  waitForAcceptedMessage,
} from "../.reader/packages/e2e/src/smtp-sink.js";

const DEV_IDENTITY = "e2e@remit.test";
const RECIPIENT = "sender@remit.test";
const SEARCHED_WORD = "Harbourmaster";

const SEEDED: Message[] = [
  { subject: `${SEARCHED_WORD} inspection on Friday`, body: "The quay closes at noon." },
  { subject: "Lunch on Thursday?", body: "Shall we try the new place on the corner?" },
  { subject: "Invoice for October", body: "Attached is the invoice for October." },
];
const SEEDED_SUBJECTS = SEEDED.map((message) => message.subject).sort();
const LATE: Message = {
  subject: "Arrived after onboarding",
  body: "Sent once the account existed.",
};
const SENT_SUBJECT = `Sent from the local Worker ${Date.now()}`;

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

const openInbox = async (page: Page): Promise<void> => {
  await page.goto(`/mail/${shared.inboxId}`);
  await expect(page.locator("a[data-message-row]").first()).toBeVisible({ timeout: 30_000 });
};

test.describe.configure({ mode: "serial" });

test.describe("reader on a local Worker", () => {
  test("GET /api/version answers the local commit", async ({ request }) => {
    const response = await request.get("/api/version");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ commit: process.env.E2E_COMMIT });
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

  test("search finds a seeded subject and nothing else", async ({ page }) => {
    const [match, ...rest] = SEEDED;
    const others = [...rest, LATE];
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
});
