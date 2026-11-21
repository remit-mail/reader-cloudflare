import { expect, test } from "@playwright/test";

const RENEWAL_KEY = "remit-access-renewal-at";
const securityPage = "/settings/security?from=mail#security";

test.beforeEach(async ({ context, page }) => {
  // Keep the expired-session screen stable while installing the real shell SW.
  await context.addInitScript(() => {
    sessionStorage.setItem("remit-access-renewal-at", String(Date.now()));
  });
  await context.route("**/api/config", (route) => route.fulfill({ status: 401, json: {} }));
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
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: expired ? 401 : 200,
      json: expired
        ? {}
        : {
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
    }),
  );
  await page.goto(securityPage);
  const security = page.getByRole("link", {
    name: "Manage two-factor authentication and passkeys",
  });
  await expect(security).toBeVisible();
  expired = true;
  const navigation = page.waitForNavigation();
  await page.evaluate((key) => {
    sessionStorage.removeItem(key);
    document.dispatchEvent(new Event("visibilitychange"));
  }, RENEWAL_KEY);
  const response = await navigation;
  expect(response?.fromServiceWorker()).toBe(false);
  expect(new URL(page.url()).searchParams.get("reauth")).toBe("1");
  expect(new URL(page.url()).searchParams.get("from")).toBe("mail");
  expect(new URL(page.url()).hash).toBe("#security");
  await expect(page.getByRole("link", { name: "Sign in again", exact: true })).toBeVisible();
  expired = false;
  await page.reload();
  await expect(security).toBeVisible();
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
