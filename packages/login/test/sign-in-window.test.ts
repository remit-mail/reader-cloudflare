import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { oauthClientUpsertSql } from "../../../npm-scripts/oauth-client.mjs";
import { sha256Base64Url } from "../src/crypto";
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
});

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
      const answer = await call("/api/auth/sign-in/email", {
        body: { email, password: PASSWORD, oauth_query: query },
      });
      expect(answer.status).toBe(200);
      expect(cookiesOf(answer)).toContain("session_token");
      expect(((await answer.json()) as { url?: string }).url).toBeUndefined();
    },
  );

  it("continues a current signed authorization with its original state", async () => {
    const email = uniqueEmail("current-query");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    const answer = await call("/api/auth/sign-in/email", {
      body: { email, password: PASSWORD, oauth_query: query },
    });
    expect(answer.status).toBe(200);
    const { url } = (await answer.json()) as { url: string };
    const callback = new URL(url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state");
    expect(callback.searchParams.get("code")).toBeTruthy();
  });

  it("still reports a wrong password after renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("wrong-after-renewal");
    await createUser(email, { password: PASSWORD });
    const query = await signInQuery();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const answer = await call("/api/auth/sign-in/email", {
      body: { email, password: "wrong", oauth_query: query },
    });
    expect(answer.status).toBe(401);
  });

  it("refuses an unexpired query with a forged signature", async () => {
    const query = new URLSearchParams(await signInQuery());
    query.set("sig", "forged");
    const answer = await call("/api/auth/sign-in/email", {
      body: { email: uniqueEmail("forged"), password: PASSWORD, oauth_query: query.toString() },
    });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe("invalid_signature");
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

  it("drops an expired query before verifying a live second-factor challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const email = uniqueEmail("second-step-renewal");
    await createUser(email, { password: PASSWORD, totp: true });
    const query = await signInQuery();
    vi.setSystemTime(Number(new URLSearchParams(query).get("exp")) * 1000 + 1000);
    const fresh = await call("/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
    });
    const code = await totpCode(Math.floor(Date.now() / 30_000));
    const answer = await call("/api/auth/two-factor/verify-totp", {
      body: { code, oauth_query: query },
      cookie: cookiesOf(fresh),
    });
    expect(answer.status).toBe(200);
    expect(cookiesOf(answer)).toContain("session_token");
    expect(((await answer.json()) as { url?: string }).url).toBeUndefined();
  });
});
