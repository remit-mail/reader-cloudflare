import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { appendRawMessage } from "../.reader/packages/e2e/src/imap.js";
import { baseUrl, connectImapAccount, mintIdentity, tenantJson } from "./tenant";

const identity = mintIdentity("pwa");
const json = tenantJson(identity);
const SUBJECT = "Mail retained after Access expires";
const BODY = "These downloaded bytes survive a cold offline launch.";
const LOGIN_HTML =
  '<html><body>Cloudflare Access<form action="/login">Sign in</form></body></html>';
let messageId: string;
let partitionKey: string;

// Sync and body delivery are asynchronous. Bound readiness to ten attempts.
const eventually = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  throw new Error("Mail was not ready after ten attempts");
};

const verified = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: /^Session verified$/ })).toBeVisible();
const unverified = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "session unverified" })).toBeVisible();
const readBody = (page: Page) =>
  expect(page.frameLocator('iframe[title="Email content"]').getByText(BODY)).toBeVisible();

const stored = (page: Page) =>
  page.evaluate(async () => {
    const request = indexedDB.open("remit-offline");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise<{ key: IDBValidKey; value: unknown }[]>(
        (resolve, reject) => {
          const tx = db.transaction("data");
          const entries: { key: IDBValidKey; value: unknown }[] = [];
          const cursor = tx.objectStore("data").openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (entry) {
              entries.push({ key: entry.key, value: entry.value });
              entry.continue();
            }
          };
          tx.oncomplete = () => resolve(entries);
          tx.onerror = () => reject(tx.error);
        },
      );
      return { records, caches: await caches.keys() };
    } finally {
      db.close();
    }
  });

const downloaded = async (page: Page) => {
  await page.goto(`/downloads/${messageId}`);
  await verified(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Content reads start only after the packaged worker controls this document.
  await page.reload();
  await readBody(page);
  await expect
    .poll(async () =>
      (await stored(page)).records.some(({ key }) => String(key).startsWith("part:")),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await stored(page)).records.some(
        ({ key, value }) =>
          String(key).startsWith("queries:") && JSON.stringify(value).includes(messageId),
      ),
    )
    .toBe(true);
};

const wiped = async (page: Page) => {
  const state = await stored(page);
  expect(state.records.filter(({ key }) => key !== "epoch")).toEqual([]);
  expect(state.caches.filter((name) => name.startsWith("remit-content-"))).toEqual([]);
  expect(state.caches.some((name) => !name.startsWith("remit-content-"))).toBe(true);
};

test.use({
  extraHTTPHeaders: { "x-dev-identity": identity },
  viewport: { width: 1440, height: 900 },
});

test.beforeAll(async () => {
  const account = await connectImapAccount(json);
  await appendRawMessage(
    account.imapUser,
    [
      `From: Sender <sender@remit.test>`,
      `To: ${account.imapUser}`,
      `Subject: ${SUBJECT}`,
      `Message-ID: <${crypto.randomUUID()}@remit.test>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p>${BODY}</p>`,
      "",
    ].join("\r\n"),
  );
  await json("POST", `/accounts/${account.accountId}/sync`);
  const mailboxes = await json<{ items: { mailboxId: string; fullPath: string }[] }>(
    "GET",
    `/accounts/${account.accountId}/mailboxes`,
  );
  const inbox = mailboxes.items.find((item) => item.fullPath === "INBOX");
  if (!inbox) throw new Error("No INBOX");
  const threads = await eventually(
    () =>
      json<{ items: { messageId: string; subject: string }[] }>(
        "GET",
        `/mailboxes/${inbox.mailboxId}/threads`,
      ),
    (page) => page.items.some((item) => item.subject === SUBJECT),
  );
  const message = threads.items.find((item) => item.subject === SUBJECT);
  if (!message) throw new Error("No seeded message");
  messageId = message.messageId;
  await eventually(async () => {
    const description = await json<{ bodyParts: { contentUrl?: string }[] }>(
      "GET",
      `/messages/${messageId}`,
    );
    const url = description.bodyParts.find((part) => part.contentUrl)?.contentUrl;
    if (!url) return false;
    const response = await fetch(url, { headers: { "x-dev-identity": identity } });
    return response.status === 200 && (await response.text()).includes(BODY);
  }, Boolean);
  ({ partitionKey } = await json<{ partitionKey: string }>("GET", "/session"));
});

test("cold offline launch keeps downloaded mail after the Access cookie expires, then reconnects", async () => {
  const profile = await mkdtemp(join(tmpdir(), "remit-access-offline-"));
  const launch = (offline = false) =>
    chromium.launchPersistentContext(profile, {
      headless: true,
      offline,
      baseURL: baseUrl(),
      extraHTTPHeaders: { "x-dev-identity": identity },
    });
  let context = await launch();
  try {
    await context.addCookies([
      { name: "CF_Authorization", value: "simulated-session", url: baseUrl() },
    ]);
    let page = await context.newPage();
    await downloaded(page);
    await context.clearCookies();
    await context.close();
    context = await launch(true);
    page = await context.newPage();
    await page.goto(`/downloads/${messageId}`);
    await unverified(page);
    await readBody(page);
    // Local Wrangler has no Access edge: simulate its expired-cookie redirect.
    await context.route("**/api/session", (route) =>
      route.fulfill({ status: 302, headers: { location: "https://access.remit.test/login" } }),
    );
    const refused = page.waitForResponse(
      (response) => response.url().endsWith("/api/session") && response.status() === 302,
    );
    await context.setOffline(false);
    await refused;
    await unverified(page);
    await readBody(page);
    await page.goto("/mail/brief");
    await unverified(page);
    await context.unroute("**/api/session");
    const session = page.waitForResponse(
      (response) => response.url().endsWith("/api/session") && response.status() === 200,
    );
    const refreshed = page.waitForResponse(
      (response) => response.url().includes("/threads") && response.status() === 200,
    );
    await page.getByRole("button", { name: "Verify session / sign in" }).click();
    await session;
    await verified(page);
    await refreshed;
    await page.goto(`/downloads/${messageId}`);
    await readBody(page);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a different server partition wipes the previous tenant before reauthentication", async ({
  context,
  page,
}) => {
  await downloaded(page);
  await context.setOffline(true);
  const otherIdentity = mintIdentity("pwa-other");
  const other = await tenantJson(otherIdentity)<{ partitionKey: string }>("GET", "/session");
  expect(other.partitionKey).not.toBe(partitionKey);
  await context.setExtraHTTPHeaders({ "x-dev-identity": otherIdentity });
  const navigation = page.waitForNavigation();
  await context.setOffline(false);
  const response = await navigation;
  expect(new URL(response?.url() ?? "").searchParams.get("reauth")).toBe("1");
  expect(response?.fromServiceWorker()).toBe(false);
  const state = await stored(page);
  expect(JSON.stringify(state.records)).not.toContain(messageId);
  expect(state.caches.some((name) => name.includes(encodeURIComponent(partitionKey)))).toBe(false);
  await expect(page.getByRole("link", { name: SUBJECT, exact: true })).toHaveCount(0);
});

test("offline logout purges downloads before leaving for the login Worker", async ({
  context,
  page,
}) => {
  await downloaded(page);
  await page.goto("/mail/brief");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await context.setOffline(true);
  // Abort the external navigation so the origin's durable stores remain inspectable.
  let completeLogout: () => void;
  const logout = new Promise<void>((resolve) => {
    completeLogout = resolve;
  });
  await context.route("http://127.0.0.1:8791/sign-out", async (route) => {
    await wiped(page);
    await route.abort();
    completeLogout();
  });
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await logout;
});

for (const hostile of ["Access HTML", "login redirect"]) {
  test(`${hostile} cannot replace downloaded app content`, async ({ context, page }) => {
    await page.goto("/downloads");
    await verified(page);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.route("**/content/**", (route) =>
      route.fulfill(
        hostile === "Access HTML"
          ? {
              status: 200,
              contentType: "text/html",
              body: LOGIN_HTML,
              headers: { "X-Remit-Partition": partitionKey },
            }
          : { status: 302, headers: { location: "https://access.remit.test/login" } },
      ),
    );
    await page.goto(`/downloads/${messageId}`);
    await expect(page.getByRole("heading", { name: SUBJECT })).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /download|content|session/i })
        .first(),
    ).toBeVisible();
    const state = await stored(page);
    expect(state.records.some(({ key }) => String(key).startsWith("part:"))).toBe(false);
    for (const name of state.caches) {
      expect(
        await page.evaluate(
          async ({ name, html }) => {
            const cache = await caches.open(name);
            return (
              await Promise.all(
                (await cache.keys()).map(async (key) => (await cache.match(key))?.text()),
              )
            ).some((body) => body?.includes(html));
          },
          { name, html: LOGIN_HTML },
        ),
      ).toBe(false);
    }
  });
}

test("the Chromium install button consumes the browser's PWA prompt", async ({ page }) => {
  await page.goto("/mail/brief");
  await verified(page);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        document.documentElement.dataset.installPrompted = "true";
      },
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    window.dispatchEvent(event);
  });
  const install = page.getByRole("button", { name: "Install app", exact: true });
  await expect(install).toBeVisible();
  await install.click();
  await expect(page.locator("html")).toHaveAttribute("data-install-prompted", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(install).toHaveCount(0);
});
