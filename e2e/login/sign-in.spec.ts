import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
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
const FIRST_PASSWORD = `e2e-${crypto.randomUUID()}`;
const RESET_PASSWORD = `e2e-${crypto.randomUUID()}`;

test.describe.configure({ mode: "serial" });

let callback: Server;
let authenticator: Authenticator;

test.beforeAll(async () => {
  callback = await serveCallback();
});

test.afterAll(() => {
  callback.close();
});

const completeAuthorization = async (page: Page, auth: Authorization): Promise<void> => {
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
  expect(claims).toMatchObject({
    aud: CLIENT_ID,
    nonce: auth.nonce,
    email: OPERATOR,
    email_verified: true,
  });

  const info = await userinfo(String(tokens.body.access_token));
  expect(info.status, JSON.stringify(info.body)).toBe(200);
  expect(info.body).toMatchObject({ sub: claims.sub, email: OPERATOR });
};

const signIn = async (page: Page, password: string): Promise<Authorization> => {
  const auth = authorization();
  await page.goto(auth.url);
  await expect(page.getByRole("heading", { name: "Sign in to remit" })).toBeVisible();
  await page.locator("#email").fill(OPERATOR);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return auth;
};

test("an emailed invite sets a password, skips the second step and authorizes", async ({
  page,
  request,
}) => {
  const seen = sentMails().length;
  const cron = await request.get(`${BASE_URL}/__scheduled?cron=${encodeURIComponent("0 * * * *")}`);
  expect(cron.status()).toBe(200);
  const [link] = await waitForMail(seen, /http\S+\/invite#\S+/);

  await page.goto(link);
  await expect(page.getByText(`This invite is for ${OPERATOR}`)).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.locator("#password").fill(FIRST_PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();

  await expect(page).toHaveURL(`${BASE_URL}/welcome/second-step`);
  await expect(page.getByRole("heading", { name: "Make your account safer" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL((url) => !url.href.startsWith(BASE_URL));

  const auth = authorization();
  await page.goto(auth.url);
  await completeAuthorization(page, auth);
});

test("email and password sign in again and authorize", async ({ page }) => {
  const auth = await signIn(page, FIRST_PASSWORD);
  await completeAuthorization(page, auth);
});

test("an authenticator app added on the welcome page is asked for at sign-in", async ({ page }) => {
  await signIn(page, FIRST_PASSWORD);
  await page.waitForURL((url) => url.href.startsWith(REDIRECT_URI));

  await page.goto(`${BASE_URL}/welcome/second-step`);
  await page.locator("#password").fill(FIRST_PASSWORD);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Authenticator app/ }).click();
  await page.locator("#password").fill(FIRST_PASSWORD);
  await page.getByRole("button", { name: "Add an authenticator app" }).click();

  const secret = (await page.locator("code").first().textContent())?.replaceAll(" ", "") ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  authenticator = new Authenticator(secret);
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Confirm", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
  await page.getByLabel("I saved my backup codes").check();
  await page.getByRole("button", { name: "Continue to remit" }).click();
  await page.waitForURL((url) => !url.href.startsWith(BASE_URL));

  await page.context().clearCookies();
  const auth = await signIn(page, FIRST_PASSWORD);
  await expect(page.getByRole("heading", { name: "Enter your app code" })).toBeVisible();
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeAuthorization(page, auth);
});

test("a password reset by emailed code signs in with the new password and the app", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/reset`);
  const seen = sentMails().length;
  await page.locator("#email").fill(OPERATOR);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const [, code] = await waitForMail(seen, /reset your remit password is (\S+)\./);

  await page.locator("#otp").fill(code ?? "");
  await page.locator("#password").fill(RESET_PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();

  await signIn(page, FIRST_PASSWORD);
  await expect(page.getByText("Wrong email or password")).toBeVisible();

  const auth = await signIn(page, RESET_PASSWORD);
  await expect(page.getByRole("heading", { name: "Enter your app code" })).toBeVisible();
  await page.locator("#code").fill(await authenticator.code());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeAuthorization(page, auth);
});
