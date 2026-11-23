import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { oauthClientUpsertSql } from "../../../npm-scripts/oauth-client.mjs";
import { sha256Base64Url } from "../src/crypto";
import { refusalOf } from "../web/src/refusal";
import { signInRequest } from "../web/src/sign-in-request";
import { call, cookiesOf, createUser, PASSWORD, testEnv, totpCode, uniqueEmail } from "./helpers";

const CLIENT_ID = "reader-cloudflare-access";
const REDIRECT = "https://team.example.com/cdn-cgi/access/callback";

const signInQuery = async (): Promise<string> => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "openid email profile",
    state: "state",
    nonce: "nonce",
    code_challenge: await sha256Base64Url("v".repeat(50)),
    code_challenge_method: "S256",
  });
  const answer = await call(`/api/auth/oauth2/authorize?${query.toString()}`);
  const location =
    answer.headers.get("location") ?? ((await answer.json()) as { url?: string }).url ?? "";
  const signed = new URL(location, "http://localhost").search.slice(1);
  if (!new URLSearchParams(signed).has("sig")) {
    throw new Error(`authorize answered ${answer.status} without a signed sign-in link`);
  }
  return signed;
};

const signInAfter = async (minutes: number) => {
  const email = uniqueEmail(`window-${minutes}`);
  await createUser(email, { password: PASSWORD });
  const oauthQuery = await signInQuery();
  vi.setSystemTime(Date.now() + minutes * 60_000);
  return call("/api/auth/sign-in/email", {
    body: { email, password: PASSWORD, oauth_query: oauthQuery },
  });
};

describe("time to type a password on the OAuth sign-in page", () => {
  beforeAll(async () => {
    await testEnv.DB.prepare(
      oauthClientUpsertSql({
        clientId: CLIENT_ID,
        secretHash: await sha256Base64Url("a-client-secret-for-tests"),
        redirectUri: REDIRECT,
        now: Date.now(),
      }),
    ).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes the authorization when the password comes two minutes later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const answer = await signInAfter(2);
    expect(answer.status).toBe(200);
    const { url } = (await answer.json()) as { url: string };
    expect(new URL(url).searchParams.get("code")).toBeTruthy();
  });

  it("still refuses an expired signed query at the server", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const answer = await signInAfter(11);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe("invalid_signature");
  });
});

// Exercise the submit logic against the Worker without importing browser globals.
const openForm = (query: string, cookie = "") => {
  let currentQuery: string | undefined = query;
  const responses: Response[] = [];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const abandonQuery = vi.fn(() => {
    currentQuery = undefined;
  });
  const submit = (path: string, body: Record<string, unknown>, delay = 0) =>
    signInRequest(
      path,
      body,
      currentQuery,
      async (target, input) => {
        if (requests.length === 0 && delay) vi.setSystemTime(Date.now() + delay);
        requests.push({ path: target, body: input });
        const response = await call(target, { body: input, cookie });
        responses.push(response.clone());
        const result = (await response.json()) as Record<string, unknown>;
        return response.ok
          ? { ok: true, status: response.status, body: result }
          : refusalOf(response.status, result);
      },
      abandonQuery,
    );
  return { submit, abandonQuery, requests, responses };
};

describe("renewing an abandoned sign-in on its first submit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([11, 180, 24 * 60, 30 * 24 * 60])(
    "signs in after %i minutes and starts fresh Access state",
    async (minutes) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const email = uniqueEmail("abandoned");
      await createUser(email, { password: PASSWORD });
      const query = await signInQuery();
      vi.setSystemTime(Date.now() + minutes * 60_000);
      const page = openForm(query);
      const answer = await page.submit("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(answer.ok).toBe(true);
      expect(page.requests).toHaveLength(1);
      expect(page.requests[0]?.body).toEqual({ email, password: PASSWORD });
      expect(cookiesOf(page.responses[0] as Response)).toContain("session_token");
      expect(page.abandonQuery).toHaveBeenCalledOnce();
      expect(answer.ok && answer.body.url).toBeUndefined();
    },
  );

  it("continues a current signed authorization with its original state", async () => {
    const email = uniqueEmail("current-query");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    const page = openForm(query);
    const answer = await page.submit("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error(answer.message);
    const callback = new URL(String(answer.body.url));
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state");
    expect(callback.searchParams.get("code")).toBeTruthy();
    expect(page.requests[0]?.body.oauth_query).toBe(query);
  });

  it("retries the password once if the request was suspended past expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("suspended");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    const page = openForm(query);
    const answer = await page.submit(
      "/api/auth/sign-in/email",
      { email, password: PASSWORD },
      11 * 60_000,
    );
    expect(answer.ok).toBe(true);
    expect(page.requests).toHaveLength(2);
    expect(page.requests[0]?.body.oauth_query).toBe(query);
    expect(page.requests[1]?.body).toEqual({ email, password: PASSWORD });
    expect(page.abandonQuery).toHaveBeenCalledOnce();
  });

  it("still reports a wrong password after renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("wrong-after-renewal");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const page = openForm(query);
    const answer = await page.submit("/api/auth/sign-in/email", { email, password: "wrong" });
    expect(answer.ok).toBe(false);
    expect(answer.status).toBe(401);
    expect(page.requests).toHaveLength(1);
  });

  it("does not retry an unexpired query with a forged signature", async () => {
    const query = new URLSearchParams(await signInQuery());
    query.set("sig", "forged");
    const page = openForm(query.toString());
    const answer = await page.submit("/api/auth/sign-in/email", {
      email: uniqueEmail("forged"),
      password: PASSWORD,
    });
    expect(answer.ok).toBe(false);
    expect(answer.status).toBe(400);
    expect(page.requests).toHaveLength(1);
  });

  it("refuses a cross-site submit even with the correct password and an old query", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("cross-site");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    for (const oauthQuery of [query, undefined]) {
      const answer = await call("/api/auth/sign-in/email", {
        headers: { origin: "https://attacker.example" },
        body: { email, password: PASSWORD, oauth_query: oauthQuery },
      });
      expect(answer.status).toBe(403);
    }
  });

  it("renews before checking a second step, and refuses replay of that submit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("second-step-renewal");
    await createUser(email, { password: PASSWORD, totp: true });
    const first = await call("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
    const cookie = cookiesOf(first);
    const query = await signInQuery();
    // Expire only the OAuth query: the password confirmation remains a separate protection.
    const oldQuery = new URLSearchParams(query);
    vi.setSystemTime(Number(oldQuery.get("exp")) * 1000 + 1000);
    // Confirm the password again to get a live, browser-bound second-factor challenge.
    const fresh = await call("/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
      cookie,
    });
    const page = openForm(query, cookiesOf(fresh));
    const code = await totpCode(Math.floor(Date.now() / 30_000));
    const answer = await page.submit("/api/auth/two-factor/verify-totp", { code });
    expect(answer.ok).toBe(true);
    expect(page.requests).toHaveLength(1);
    const replay = await page.submit("/api/auth/two-factor/verify-totp", { code });
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe(401);
  });
});
