import { beforeAll, describe, expect, it } from "vitest";
import { oauthClientUpsertSql } from "../../../npm-scripts/oauth-client.mjs";
import { sha256Base64Url } from "../src/crypto";
import worker from "../src/index";
import { call, createUser, ORIGIN, signIn, testEnv, uniqueEmail } from "./helpers";

const CLIENT_ID = "reader-cloudflare-access";
const CLIENT_SECRET = "a-client-secret-for-tests";
const REDIRECT = "https://team.example.com/cdn-cgi/access/callback";
const VERIFIER = "v".repeat(50);

const authorizeResponse = async (cookie: string): Promise<Response> => {
  const challenge = await sha256Base64Url(VERIFIER);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "openid email profile",
    state: "state",
    nonce: "nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return call(`/api/auth/oauth2/authorize?${query.toString()}`, { cookie });
};

const authorize = async (cookie: string): Promise<string> => {
  const answer = await authorizeResponse(cookie);
  const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code");
  if (code === null) throw new Error(`authorize answered ${answer.status} without a code`);
  return code;
};

const redeem = (code: string): Promise<Response> =>
  worker.fetch(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "192.0.2.10",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    }),
    testEnv,
  );

describe("authorization code after the sign-in ended", () => {
  beforeAll(async () => {
    const sql = oauthClientUpsertSql({
      clientId: CLIENT_ID,
      secretHash: await sha256Base64Url(CLIENT_SECRET),
      redirectUri: REDIRECT,
      now: Date.now(),
    });
    await testEnv.DB.prepare(sql).run();
  });

  it("issues tokens for a live sign-in and records who got them", async () => {
    const email = uniqueEmail("live");
    const user = await createUser(email);
    const answer = await redeem(await authorize((await signIn(user.id)).cookie));
    expect(answer.status).toBe(200);
    const { id_token: idToken, refresh_token: refreshToken } = (await answer.json()) as {
      id_token: string;
      refresh_token?: string;
    };
    expect(refreshToken).toBeUndefined();
    const claims = JSON.parse(
      atob((idToken.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
    ) as { email?: string };
    expect(claims.email).toBe(email);
    const audited = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_event WHERE email = ? AND event = 'TokenIssued' AND outcome = 'Succeeded'",
    )
      .bind(email)
      .first<{ count: number }>();
    expect(audited?.count).toBe(1);
  });

  it("silently renews an old live login and its cookie on OIDC authorization", async () => {
    const user = await createUser(uniqueEmail("rolling-login"));
    const session = await signIn(user.id);
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    await testEnv.DB.prepare("UPDATE session SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(now + 88 * day, now - 2 * day, session.sessionId)
      .run();

    const answer = await authorizeResponse(session.cookie);
    expect(answer.status).toBe(302);
    expect(new URL(answer.headers.get("location") ?? "").origin).toBe(new URL(REDIRECT).origin);
    expect(answer.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^better-auth\.session_token=.+;.*Max-Age=7776000/),
    );
    const live = await testEnv.DB.prepare("SELECT expires_at FROM session WHERE id = ?")
      .bind(session.sessionId)
      .first<{ expires_at: number }>();
    expect(live?.expires_at).toBeGreaterThanOrEqual(now + 90 * day - 1000);

    // Tabs share an opaque login cookie, not a rotating OAuth refresh token.
    const codes = await Promise.all([authorize(session.cookie), authorize(session.cookie)]);
    expect(codes[0]).not.toBe(codes[1]);
    const tokens = await Promise.all(codes.map(redeem));
    expect(tokens.map((response) => response.status)).toEqual([200, 200]);
    expect((await call("/api/auth/get-session", { cookie: session.cookie })).status).toBe(200);
  });

  it("refuses a code whose session was deleted after it was issued", async () => {
    const email = uniqueEmail("signed-out");
    const user = await createUser(email);
    const session = await signIn(user.id);
    const code = await authorize(session.cookie);
    await testEnv.DB.prepare("DELETE FROM session WHERE id = ?").bind(session.sessionId).run();
    const answer = await redeem(code);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe("invalid_grant");
    const refused = await testEnv.DB.prepare(
      "SELECT client_id FROM audit_event WHERE email = ? AND event = 'TokenIssued' AND outcome = 'Refused'",
    )
      .bind(email)
      .first<{ client_id: string }>();
    expect(refused?.client_id).toBe(CLIENT_ID);
  });

  it("refuses a code for a user banned after it was issued", async () => {
    const user = await createUser(uniqueEmail("banned"));
    const code = await authorize((await signIn(user.id)).cookie);
    await testEnv.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(user.id).run();
    const answer = await redeem(code);
    expect(answer.status).toBe(400);
  });
});
