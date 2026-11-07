import type { Server } from "node:http";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  Authenticator,
  type Authorization,
  authorization,
  BASE_URL,
  CLIENT_ID,
  exchange,
  REDIRECT_URI,
  sentMails,
  serveCallback,
  userinfo,
  verifiedClaims,
  waitForMail,
} from "./harness";

const OPERATOR = "operator@remit.test";
const NEWCOMER = "newcomer@remit.test";
const FIRST_PASSWORD = `e2e-${crypto.randomUUID()}`;
const RESET_PASSWORD = `e2e-${crypto.randomUUID()}`;
const NEWCOMER_PASSWORD = `e2e-${crypto.randomUUID()}`;
const NEWCOMER_RESET_PASSWORD = `e2e-${crypto.randomUUID()}`;

test.describe.configure({ mode: "serial" });

let callback: Server;
let authenticator: Authenticator;
let newcomerInvite: string;

test.beforeAll(async () => {
  callback = await serveCallback();
});

test.afterAll(() => {
  callback.close();
});

const completeAuthorization = async (
  page: Page,
  auth: Authorization,
  email: string,
): Promise<void> => {
  await page.waitForURL((url) => url.href.startsWith(REDIRECT_URI), { timeout: 15_000 });
  const returned = new URL(page.url());
  expect(returned.searchParams.get("error")).toBeNull();
  expect(returned.searchParams.get("state")).toBe(auth.state);
  const code = returned.searchParams.get("code");
  expect(code).not.toBeNull();

  const tokens = await exchange(code ?? "", auth.verifier);
  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
  expect(typeof tokens.body.id_token).toBe("string");
  expect(typeof tokens.body.access_token).toBe("string");

  const claims = await verifiedClaims(String(tokens.body.id_token));
  expect(claims).toMatchObject({ aud: CLIENT_ID, nonce: auth.nonce, email, email_verified: true });

  const info = await userinfo(String(tokens.body.access_token));
  expect(info.status, JSON.stringify(info.body)).toBe(200);
  expect(info.body).toMatchObject({ sub: claims.sub, email });
};

const signIn = async (page: Page, email: string, password: string): Promise<Authorization> => {
  const auth = authorization();
  await page.goto(auth.url);
  await expect(page.getByRole("heading", { name: "Sign in to remit" })).toBeVisible();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return auth;
};

const post = (request: APIRequestContext, path: string, data: unknown) =>
  request.post(`${BASE_URL}${path}`, { data, headers: { origin: BASE_URL } });

const looked = new Map<string, string | null>();

const invitedEmail = async (request: APIRequestContext, link: string): Promise<string | null> => {
  const known = looked.get(link);
  if (known !== undefined) return known;
  const token = new URL(link).hash.slice(1);
  const answer = await post(request, "/app/invite/lookup", { token });
  const email = answer.ok() ? String(((await answer.json()) as { email?: unknown }).email) : null;
  looked.set(link, email);
  return email;
};

const inviteLinksSince = (seen: number): string[] =>
  sentMails()
    .slice(seen)
    .flatMap((text) => [...text.matchAll(/http\S+\/invite#\S+/g)].map((match) => match[0]));

const waitForInvite = async (
  request: APIRequestContext,
  seen: number,
  email: string,
): Promise<string> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const link of inviteLinksSince(seen)) {
      if ((await invitedEmail(request, link)) === email) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no live invite for ${email} after the first ${seen} emails`);
};

const openLink = async (page: Page, link: string): Promise<void> => {
  await page.goto("about:blank");
  await page.goto(link);
};

const holdOpeningRemit = (page: Page) =>
  page.route("**/app/config", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });

const expectOpeningRemit = async (page: Page): Promise<void> => {
  await expect(page.getByRole("heading", { name: "Opening remit" })).toBeVisible();
  await page.waitForURL((url) => !url.href.startsWith(BASE_URL));
};

const enrollApp = async (page: Page): Promise<Authenticator> => {
  await expect(page.locator("#code")).toBeFocused();
  const secret = (await page.locator("code").first().textContent())?.replaceAll(" ", "") ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  const app = new Authenticator(secret);
  await page.locator("#code").fill(await app.code());
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  return app;
};

test("a replaced invite mails a fresh one, a reload drops the token, and the app enrolls without a password", async ({
  page,
  request,
}) => {
  const seen = sentMails().length;
  const cron = await request.get(`${BASE_URL}/__scheduled?cron=${encodeURIComponent("0 * * * *")}`);
  expect(cron.status()).toBe(200);
  const first = await waitForInvite(request, seen, OPERATOR);
  newcomerInvite = await waitForInvite(request, seen, NEWCOMER);

  const renewed = sentMails().length;
  const fresh = await post(request, "/app/link/fresh", { token: new URL(first).hash.slice(1) });
  expect(fresh.status()).toBe(202);
  await waitForInvite(request, renewed, OPERATOR);

  await openLink(page, first);
  await expect(page.getByRole("heading", { name: "This invite has expired" })).toBeVisible();
  const button = page.getByRole("button", { name: "Email me a fresh invite" });
  await expect(button).toBeFocused();
  const resent = sentMails().length;
  await button.click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const link = await waitForInvite(request, resent, OPERATOR);

  await openLink(page, link);
  await expect(page.getByText(`This invite is for ${OPERATOR}`)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Open the link from your email" })).toBeVisible();

  await openLink(page, link);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.locator("#password").fill(FIRST_PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();

  await expect(page).toHaveURL(`${BASE_URL}/welcome/second-step`);
  await expect(page.getByRole("heading", { name: "Make your account safer" })).toBeVisible();
  await page.getByRole("button", { name: /Authenticator app/ }).click();
  await expect(page.locator("#password")).toHaveCount(0);
  authenticator = await enrollApp(page);

  await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
  await page.getByLabel("I saved my backup codes").check();
  await holdOpeningRemit(page);
  await page.getByRole("button", { name: "Continue to remit" }).click();
  await expectOpeningRemit(page);

  await page.context().clearCookies();
  const auth = await signIn(page, OPERATOR, FIRST_PASSWORD);
  await expect(page.getByRole("heading", { name: "Enter your app code" })).toBeVisible();
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeAuthorization(page, auth, OPERATOR);
});

test("skip for now opens remit", async ({ page }) => {
  await openLink(page, newcomerInvite);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#password").fill(NEWCOMER_PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("heading", { name: "Make your account safer" })).toBeVisible();
  await holdOpeningRemit(page);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expectOpeningRemit(page);

  const auth = authorization();
  await page.goto(auth.url);
  await completeAuthorization(page, auth, NEWCOMER);
});

const requestResetLink = async (page: Page, email: string): Promise<string> => {
  const auth = authorization();
  await page.goto(auth.url);
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page).toHaveURL(/\/reset\?.*client_id=/);
  await expect(page.locator("#email")).toBeFocused();
  const seen = sentMails().length;
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeFocused();
  const [link] = await waitForMail(seen, /http\S+\/reset\/password#\S+/);
  return link;
};

test("a reset link with no second step opens remit", async ({ page }) => {
  await page.context().clearCookies();
  const link = await requestResetLink(page, NEWCOMER);
  await openLink(page, link);
  await expect(page.getByText(NEWCOMER)).toBeVisible();
  await expect(page.locator("#password")).toBeFocused();
  await page.locator("#password").fill(NEWCOMER_RESET_PASSWORD);
  await holdOpeningRemit(page);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expectOpeningRemit(page);
});

test("security adds an app after skip, and a confirm resumes it", async ({ page }) => {
  await page.context().clearCookies();
  await signIn(page, NEWCOMER, NEWCOMER_RESET_PASSWORD);
  await page.waitForURL((url) => url.href.startsWith(REDIRECT_URI));

  await page.goto(`${BASE_URL}/security`);
  const addApp = page.getByRole("button", { name: "Add an authenticator app" });
  await addApp.click();
  await expect(page.getByRole("dialog", { name: "Confirm it is you" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(addApp).toBeFocused();

  await addApp.click();
  await expect(page.getByRole("dialog", { name: "Confirm it is you" })).toBeVisible();
  await expect(page.locator("#password")).toBeFocused();
  await page.locator("#password").fill(NEWCOMER_RESET_PASSWORD);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add an authenticator app" })).toBeVisible();
  await enrollApp(page);
  await expect(page.getByRole("dialog", { name: "Your new backup codes" })).toBeVisible();
});

test("a reset link on an app account lands on the second step", async ({ page }) => {
  await page.context().clearCookies();
  const link = await requestResetLink(page, OPERATOR);
  await openLink(page, link);
  await expect(page.getByText(OPERATOR)).toBeVisible();
  await openLink(page, link);
  await expect(page.getByText(OPERATOR)).toBeVisible();
  await page.locator("#password").fill(RESET_PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();

  await expect(page).toHaveURL(`${BASE_URL}/sign-in/second-step`);
  await expect(page.getByText("Password changed")).toBeVisible();
  await expect(page.locator("#code")).toBeFocused();
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL((url) => !url.href.startsWith(BASE_URL));

  await page.context().clearCookies();
  await signIn(page, OPERATOR, FIRST_PASSWORD);
  await expect(page.getByText("Wrong email or password")).toBeVisible();

  const auth = await signIn(page, OPERATOR, RESET_PASSWORD);
  await expect(page.getByRole("heading", { name: "Enter your app code" })).toBeVisible();
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeAuthorization(page, auth, OPERATOR);
});
