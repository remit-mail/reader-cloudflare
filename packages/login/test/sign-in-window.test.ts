import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { oauthClientUpsertSql } from "../../../npm-scripts/oauth-client.mjs";
import { sha256Base64Url } from "../src/crypto";
import { call, createUser, PASSWORD, testEnv, uniqueEmail } from "./helpers";

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

  it("refuses the sign-in page after ten minutes as expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const answer = await signInAfter(11);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe("invalid_signature");
  });
});
