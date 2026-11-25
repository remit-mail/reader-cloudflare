import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendRawMessage } from "../.reader/packages/e2e/src/imap.js";
import { baseUrl, connectImapAccount, type ImapAccount, mintIdentity, tenantJson } from "./tenant";

const identity = mintIdentity("pwa");
const json = tenantJson(identity);
const SUBJECT = "Mail retained after Access expires";
const BODY = "These downloaded bytes survive a cold offline launch.";
const IMAGE_URL = "https://images.remit.test/pixel.png?token=private";
const LOGIN_HTML =
  '<html><body>Cloudflare Access<form action="/login">Sign in</form></body></html>';
let messageId: string;
let partitionKey: string;
let account: ImapAccount;

const poll = { timeout: 52_000, intervals: Array.from({ length: 9 }, (_, i) => 100 * 2 ** i) };

const shellReady = (page: Page) => expect(page.getByRole("main")).toBeVisible();
const readBody = (page: Page, body = BODY) =>
  expect(page.frameLocator('iframe[title="Email content"]').getByText(body)).toBeVisible();

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
  await shellReady(page);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), poll)
    .toBe(true);
  // Content reads start only after the packaged worker controls this document.
  await page.reload();
  await readBody(page);
  await expect
    .poll(
      async () => (await stored(page)).records.some(({ key }) => String(key).startsWith("part:")),
      poll,
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await stored(page)).records.some(
          ({ key, value }) =>
            String(key).startsWith("queries:") && JSON.stringify(value).includes(messageId),
        ),
      poll,
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

const syncMessage = async (subject: string, body: string, extraHtml = "") => {
  await appendRawMessage(
    account.imapUser,
    [
      `From: Sender <sender@remit.test>`,
      `To: ${account.imapUser}`,
      `Subject: ${subject}`,
      `Message-ID: <${crypto.randomUUID()}@remit.test>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p>${body}</p>${extraHtml}`,
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
  const threads = await waitFor(
    () =>
      json<{ items: { messageId: string; subject: string }[] }>(
        "GET",
        `/mailboxes/${inbox.mailboxId}/threads`,
      ),
    (page) => page.items.some((item) => item.subject === subject),
  );
  const message = threads.items.find((item) => item.subject === subject);
  if (!message) throw new Error(`Expected synced message "${subject}"`);
  const contentUrl = await waitFor(async () => {
    const description = await json<{ bodyParts: { contentUrl?: string }[] }>(
      "GET",
      `/messages/${message.messageId}`,
    );
    const url = description.bodyParts.find((part) => part.contentUrl)?.contentUrl;
    if (!url) return;
    const response = await fetch(url, { headers: { "x-dev-identity": identity } });
    if (response.status === 200 && (await response.text()).includes(body)) return url;
  }, Boolean);
  if (!contentUrl) throw new Error(`Expected body for "${subject}"`);
  return { messageId: message.messageId, contentUrl };
};

test.beforeAll(async () => {
  account = await connectImapAccount(json);
  ({ messageId } = await syncMessage(
    SUBJECT,
    BODY,
    `<img alt="external test image" src="${IMAGE_URL}">`,
  ));
  ({ partitionKey } = await json<{ partitionKey: string }>("GET", "/session"));
});

test("the mail shell has no offline storage bar", async ({ page }) => {
  await page.goto("/mail/brief");
  await shellReady(page);
  await expect(page.getByText(SUBJECT, { exact: true }).first()).toBeVisible();
  for (const text of [
    "Downloaded mail",
    "Session verified",
    "MiB used",
    "Storage may be removed",
    "Keep downloads on this device",
  ]) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
});

const refreshTag = "remit-refresh";
const refreshTags = (page: Page) =>
  page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      periodicSync: { getTags(): Promise<string[]> };
    };
    return registration.periodicSync.getTags();
  });

const backgroundTest = test.extend<{
  background: { context: BrowserContext; page: Page; dispatch(): Promise<void> };
}>({
  background: async ({ baseURL: origin }, use) => {
    if (!origin) throw new Error("Missing Playwright baseURL");
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      baseURL: origin,
      extraHTTPHeaders: { "x-dev-identity": identity },
    });
    try {
      await context.route("**/*", (route) => {
        const request = route.request();
        return request.serviceWorker()
          ? route.continue({ headers: { ...request.headers(), "x-dev-identity": identity } })
          : route.continue();
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Browser.setPermission", {
        permission: { name: "periodic-background-sync" },
        setting: "granted",
        origin,
      });
      const registrationId = new Promise<string>((resolve) => {
        cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
          const registration = registrations.find(({ scopeURL }) => scopeURL === `${origin}/`);
          if (registration) resolve(registration.registrationId);
        });
      });
      await cdp.send("ServiceWorker.enable");
      await page.goto("/downloads");
      await expect.poll(() => refreshTags(page), poll).toContain(refreshTag);
      await shellReady(page);
      await use({
        context,
        page,
        dispatch: async () => {
          await cdp.send("ServiceWorker.dispatchPeriodicSyncEvent", {
            origin,
            registrationId: await registrationId,
            tag: refreshTag,
          });
        },
      });
    } finally {
      await context.close();
    }
  },
});

backgroundTest(
  "one background refresh makes new mail readable offline in Downloads",
  async ({ background: { context, page, dispatch } }) => {
    const unique = crypto.randomUUID();
    const subject = `Background refresh ${unique}`;
    const body = `Downloaded in the background: ${unique}`;
    const message = await syncMessage(subject, body);
    const { origin, pathname } = new URL(message.contentUrl);
    const partSaved = async () =>
      (await stored(page)).records.some(
        ({ key }) =>
          String(key).startsWith("part:") && String(key).endsWith(`:${origin}${pathname}`),
      );

    expect(await partSaved()).toBe(false);
    await dispatch();
    await expect.poll(partSaved, poll).toBe(true);
    await context.setOffline(true);
    await page.goto(`/downloads/${message.messageId}`);
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();
    await readBody(page, body);
  },
);

backgroundTest(
  "a background session refusal removes the refresh tag without fetching mail",
  async ({ background: { context, page, dispatch } }) => {
    const requests: string[] = [];
    let requestedWith: string | undefined;
    await context.route("**/api/session", async (route) => {
      const request = route.request();
      if (!request.serviceWorker()) return route.fallback();
      const headers = request.headers();
      requestedWith = headers["x-requested-with"];
      const response = await route.fetch({
        headers: { ...headers, "x-dev-identity": "none" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(401);
      await route.fulfill({ response });
    });
    const before = await stored(page);
    context.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        request.serviceWorker() &&
        (pathname.startsWith("/api/") || pathname.startsWith("/content/"))
      ) {
        requests.push(pathname);
      }
    });
    await dispatch();
    await expect.poll(() => refreshTags(page), poll).not.toContain(refreshTag);
    expect(await stored(page)).toEqual(before);
    expect(requests).toEqual(["/api/session"]);
    expect(requestedWith).toBe("XMLHttpRequest");
  },
);

const imageReady = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const image = document
            .querySelector<HTMLIFrameElement>('iframe[title="Email content"]')
            ?.contentDocument?.querySelector<HTMLImageElement>('img[alt="external test image"]');
          return (
            !!image && image.src.startsWith("blob:") && image.complete && image.naturalWidth === 1
          );
        }),
      poll,
    )
    .toBe(true);

test("a permitted external image uses the POST proxy and reopens offline", async ({
  context,
  page,
}) => {
  const requests: {
    method: string;
    url: string;
    body: string | null;
    contentType: string | undefined;
  }[] = [];
  // Fixture the remote image response; exercise the real renderer, runtime config,
  // partition admission and durable browser storage without an external server.
  await context.route("**/api/image-proxy", async (route) => {
    const request = route.request();
    requests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
      contentType: request.headers()["content-type"],
    });
    await route.fulfill({
      contentType: "image/png",
      headers: { "X-Remit-Partition": partitionKey },
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  const direct: string[] = [];
  context.on("request", (request) => {
    if (request.url() === IMAGE_URL) direct.push(request.url());
  });
  await downloaded(page);
  await page.getByRole("button", { name: "Load once", exact: true }).click();
  await imageReady(page);
  expect(requests).toEqual([
    {
      method: "POST",
      url: `${baseUrl()}/api/image-proxy`,
      body: IMAGE_URL,
      contentType: "text/plain;charset=UTF-8",
    },
  ]);
  await context.setOffline(true);
  await page.reload();
  await readBody(page);
  await page.getByRole("button", { name: "Load once", exact: true }).click();
  await imageReady(page);
  expect(requests).toHaveLength(1);
  expect(direct).toEqual([]);
});

test("a blocked external image sends no proxy request", async ({ context, page }) => {
  const requests: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/image-proxy" || request.url() === IMAGE_URL)
      requests.push(request.url());
  });
  await downloaded(page);
  await expect(page.getByRole("button", { name: "Load once", exact: true })).toBeVisible();
  expect(requests).toEqual([]);
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
    await page.goto("/mail/brief");
    await expect(page.getByText(SUBJECT, { exact: true }).first()).toBeVisible();
    await context.clearCookies();
    await context.close();
    context = await launch(true);
    page = await context.newPage();
    await page.goto(`/downloads/${messageId}`);
    await readBody(page);
    // Return to the remembered list while still offline, before recovery starts.
    await page.goto("/mail/brief");
    await expect(page.getByText(SUBJECT, { exact: true }).first()).toBeVisible();
    // Local Wrangler has no Access edge: simulate its expired-cookie redirect.
    await context.route("**/api/session", (route) =>
      route.fulfill({ status: 302, headers: { location: "https://access.remit.test/login" } }),
    );
    // A manual cross-origin redirect is opaque in Chromium, so it does not
    // expose a 302 response event to Playwright.
    const refused = page.waitForRequest("**/api/session");
    // Exercise manual recovery when automatic renewal has already run once.
    await page.evaluate(() =>
      sessionStorage.setItem("remit-access-renewal-at", String(Date.now())),
    );
    await context.setOffline(false);
    await refused;
    await expect(page.getByText(SUBJECT, { exact: true }).first()).toBeVisible();
    const signIn = page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Sign in", exact: true });
    await expect(signIn).toBeVisible();
    await context.unroute("**/api/session");
    const session = page.waitForResponse(
      (response) => response.url().endsWith("/api/session") && response.status() === 200,
    );
    const config = page.waitForResponse(
      (response) => response.url().endsWith("/api/config") && response.status() === 200,
    );
    await signIn.click();
    await session;
    await shellReady(page);
    await config;
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
  const observer = await context.newPage();
  await observer.goto("/downloads");
  await shellReady(observer);
  await page.goto("/mail/brief");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await context.setOffline(true);
  // Inspect from another tab: evaluating the navigating page while its request
  // is paused deadlocks Chromium's navigation. Keep the external hop local.
  await context.route("http://127.0.0.1:8791/sign-out", (route) => route.abort());
  const logout = page.waitForRequest("http://127.0.0.1:8791/sign-out");
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await logout;
  await wiped(observer);
});

for (const hostile of ["Access HTML", "login redirect"]) {
  test(`${hostile} cannot replace downloaded app content`, async ({ context, page }) => {
    await page.goto("/downloads");
    await shellReady(page);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), poll)
      .toBe(true);
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
        .filter({ hasText: /message body|download|content|session/i })
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
  await shellReady(page);
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
