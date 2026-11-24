import { expect, test } from "@playwright/test";

const partitionKey = "upgrade-tenant";
const subject = "Mail across an app upgrade";
const body = "This body must load without signing out.";
const email = "upgrade@remit.test";
const row = {
  accountConfigId: partitionKey,
  accountId: "account1",
  mailboxId: "inbox1",
  threadId: "thread1",
  threadMessageId: "tm1",
  messageId: "message1",
  subject,
  fromName: "Sender",
  fromEmail: "sender@remit.test",
  sentDate: Date.now(),
  snippet: body,
  category: "personal",
  isRead: true,
  hasAttachment: false,
  star: "yellow",
  hasStars: true,
  isDeleted: false,
  status: "active",
  syncStatus: "synced",
  abandonedMutation: "none",
  senderTrust: "unknown",
  muted: false,
  spamVerdict: { state: "NotChecked" },
  spamCleared: false,
};

test.use({ viewport: { width: 1440, height: 900 } });

// Real built shell, packaged SW, IndexedDB and Cache Storage. Only Access and
// mail responses are fixtures; no browser storage or runtime methods are mocked.
test("remembered mail renews expired Access on reload without signing out", async ({
  context,
  page,
}) => {
  let expired = false;
  let renewals = 0;
  let configs = 0;
  let bodies = 0;
  let buildCommit = process.env.E2E_UPGRADE_FROM_COMMIT ?? process.env.E2E_COMMIT;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && url.searchParams.get("reauth") === "1") {
      renewals++;
      expired = false; // Access silently renews from the existing login session.
      return route.continue();
    }
    const headers = { "X-Remit-Partition": partitionKey };
    const json = (value: unknown) => route.fulfill({ json: value, headers });
    if (url.pathname === "/api/session") {
      return expired
        ? route.fulfill({ status: 302, headers: { location: "https://access.remit.test/login" } })
        : json({ partitionKey });
    }
    if (url.pathname === "/api/config") {
      configs++;
      return json({
        accounts: [
          {
            accountConfigId: partitionKey,
            accountId: row.accountId,
            email,
            username: email,
            syncedServices: ["Mail"],
            grantedScopes: [],
            isActive: true,
            connectionState: "authenticated",
            folderAppointments: [{ role: "Inbox", source: "Detected", mailboxId: row.mailboxId }],
            lastSyncAt: Date.now(),
          },
        ],
        accountConfig: { accountConfigId: partitionKey, userId: "user1", state: "active" },
        buildCommit,
      });
    }
    if (url.pathname.endsWith("/mailboxes"))
      return json({
        items: [
          {
            accountId: row.accountId,
            mailboxId: row.mailboxId,
            fullPath: "INBOX",
            hierarchyDelimiter: "/",
            messageCount: 1,
            unseenCount: 0,
            syncStatus: "synced",
          },
        ],
      });
    if (url.pathname === "/api/messages/message1")
      return json({
        message: { ...row, uid: 1, internalDate: row.sentDate },
        envelope: { subject, from: [], to: [], cc: [], bcc: [], replyTo: [] },
        flags: ["\\Seen"],
        references: [],
        bodyParts: [
          {
            bodyPartId: "part1",
            partPath: "1",
            mediaType: "TEXT",
            mediaSubtype: "HTML",
            isMultipart: false,
            sizeOctets: body.length,
            contentUrl: `${url.origin}/content/upgrade/body`,
          },
        ],
      });
    if (url.pathname.startsWith("/content/")) {
      bodies++;
      return route.fulfill({ body: `<p>${body}</p>`, contentType: "text/html", headers });
    }
    if (url.pathname === "/api/system/update") return json({ state: "idle" });
    if (url.pathname.startsWith("/api/")) {
      return json({ items: url.pathname.includes("threads") ? [row] : [], total: 0 });
    }
    return route.continue();
  });

  await page.goto("/mail/flagged");
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 })
    .toBe(true);
  // Wait for the list to reach durable storage, but deliberately do not download
  // its body: this is the existing-user profile that exposed the regression.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("remit-offline");
        const db = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        try {
          return await new Promise<boolean>((resolve) => {
            const read = db.transaction("data").objectStore("data").getAll();
            read.onsuccess = () => resolve(JSON.stringify(read.result).includes("thread1"));
          });
        } finally {
          db.close();
        }
      }),
    )
    .toBe(true);
  const cachedShell = await page.reload();
  expect(cachedShell?.fromServiceWorker()).toBe(true);
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  expect(renewals).toBe(0);
  expect(bodies).toBe(0);
  const priorConfigs = configs;
  expired = true;
  if (process.env.E2E_UPGRADE_CONTROL) {
    // The upgrade runner switches the real Worker behind this same origin.
    buildCommit = process.env.E2E_COMMIT;
    const switched = await fetch(process.env.E2E_UPGRADE_CONTROL, { method: "POST" });
    expect(switched.ok).toBe(true);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  } else {
    // SW navigation keeps serving the signed-in shell after Access expires.
    await page.reload();
  }
  await expect.poll(() => renewals, { timeout: 30_000 }).toBe(1);
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  expect(configs).toBeGreaterThan(priorConfigs);
  await page.goto("/downloads/message1");
  await expect(page.frameLocator('iframe[title="Email content"]').getByText(body)).toBeVisible();
  expect(bodies).toBeGreaterThan(0);
});
