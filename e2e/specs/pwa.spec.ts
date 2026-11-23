import { expect, test } from "@playwright/test";

const RENEWAL_KEY = "remit-access-renewal-at";
const securityPage = "/settings/security?from=mail#security";

test.beforeEach(async ({ context, page }) => {
  // Keep the expired-session screen stable while installing the real shell SW.
  await context.addInitScript(() => {
    sessionStorage.setItem("remit-access-renewal-at", String(Date.now()));
  });
  await context.route("**/api/session", (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 30_000,
    })
    .toBe(true);
});

test("an active SW serves app navigations from the shell cache", async ({ page }) => {
  const response = await page.goto("/calendar?view=week");
  expect(response?.status()).toBe(200);
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.locator("#root")).toHaveCount(1);
});

for (const path of ["/consent", "/device", "/apps"]) {
  test(`an active SW leaves ${path} with the production server route`, async ({
    page,
    request,
  }) => {
    const server = await request.get(path, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(server.status()).toBeLessThan(500);
    expect(await server.text()).not.toContain('<div id="root">');
    const response = await page.goto(path);
    expect(response?.fromServiceWorker()).toBe(false);
    expect(response?.status()).toBe(server.status());
    expect(response?.headers()["x-correlation-id"]).toBeTruthy();
    await expect(page.locator("#root")).toHaveCount(0);
  });
}

test("an active SW leaves missing icon navigations as 404", async ({ page, request }) => {
  const server = await request.get("/icons/missing.png", {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });
  expect(server.status()).toBe(404);
  const response = await page.goto("/icons/missing.png");
  expect(response?.status()).toBe(404);
  expect(response?.fromServiceWorker()).toBe(false);
  expect(response?.headers()["x-correlation-id"]).toBeTruthy();
  expect(response?.headers()["content-type"] ?? "").not.toContain("text/html");
  await expect(page.locator("#root")).toHaveCount(0);
});

test("Access expiry renews through the network with an active SW", async ({ page }) => {
  let expired = false;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: expired ? 401 : 200,
      json: expired ? {} : { partitionKey: "pwa" },
    }),
  );
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        accountConfig: {
          accountConfigId: "pwa",
          userId: "pwa",
          state: "active",
          createdAt: 0,
          updatedAt: 0,
        },
        buildCommit: process.env.E2E_COMMIT,
      },
      headers: { "X-Remit-Partition": "pwa" },
    }),
  );
  await page.goto(securityPage);
  const security = page.getByRole("link", {
    name: "Manage two-factor authentication and passkeys",
  });
  await expect(security).toBeVisible();
  expired = true;
  await page.evaluate((key) => {
    sessionStorage.removeItem(key);
    window.dispatchEvent(new Event("online"));
  }, RENEWAL_KEY);
  await expect(page.getByRole("status").filter({ hasText: "session unverified" })).toBeVisible();
  const navigation = page.waitForNavigation();
  await page.getByRole("button", { name: "Verify session / sign in" }).click();
  const response = await navigation;
  expect(response?.fromServiceWorker()).toBe(false);
  expect(new URL(page.url()).searchParams.get("reauth")).toBe("1");
  expect(new URL(page.url()).searchParams.get("from")).toBe("mail");
  expect(new URL(page.url()).hash).toBe("#security");
  await expect(page.getByRole("link", { name: "Sign in again", exact: true })).toBeVisible();
  expired = false;
  await page.reload();
  await expect(security).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Session verified$/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("reauth")).toBe(false);
  expect(new URL(page.url()).searchParams.get("from")).toBe("mail");
  expect(new URL(page.url()).hash).toBe("#security");
});

test("Sign in again reaches the network with an active SW", async ({ page }) => {
  await page.goto(securityPage);
  const signIn = page.getByRole("link", { name: "Sign in again", exact: true });
  await expect(signIn).toHaveAttribute("href", "/settings/security?from=mail&reauth=1#security");
  const navigation = page.waitForNavigation();
  await signIn.click();
  const response = await navigation;
  expect(response?.fromServiceWorker()).toBe(false);
  expect(new URL(page.url()).searchParams.get("reauth")).toBe("1");
});

for (const response of [
  {
    name: "login HTML",
    status: 200,
    contentType: "text/html",
    body: "<html>Cloudflare Access</html>",
  },
  { name: "malformed JSON", status: 200, contentType: "application/json", body: "{" },
  {
    name: "empty identity",
    status: 200,
    contentType: "application/json",
    body: '{"partitionKey":""}',
  },
  { name: "server failure", status: 503, contentType: "application/json", body: "{}" },
]) {
  test(`session verification rejects ${response.name} without authenticating`, async ({ page }) => {
    await page.route("**/api/session", (route) => route.fulfill(response));
    await page.goto("/downloads");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Session verified$/ })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("reauth")).toBe(false);
    expect(
      await page.evaluate(async () =>
        (await caches.keys()).some((name) => name.startsWith("remit-content-")),
      ),
    ).toBe(false);
  });
}
