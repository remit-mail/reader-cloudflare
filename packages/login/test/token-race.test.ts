import { beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url } from "../src/crypto";
import worker from "../src/index";
import { call, createUser, ORIGIN, signIn, testEnv, uniqueEmail } from "./helpers";

const CLIENT_ID = "reader-cloudflare-access";
const CLIENT_SECRET = "a-client-secret-for-tests";
const REDIRECT = "https://team.example.com/cdn-cgi/access/callback";
const VERIFIER = "v".repeat(50);

const authorize = async (cookie: string): Promise<string> => {
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
  const answer = await call(`/api/auth/oauth2/authorize?${query.toString()}`, { cookie });
  const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code");
  if (code === null) throw new Error(`authorize answered ${answer.status} without a code`);
  return code;
};

const redeem = (code: string): Promise<Response> =>
  worker.fetch(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "192.0.2.10",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: VERIFIER,
      }),
    }),
    testEnv,
  );

describe("authorization code after the sign-in ended", () => {
  beforeAll(async () => {
    await testEnv.DB.prepare(
      `INSERT OR REPLACE INTO oauth_client (id, client_id, client_secret, disabled, skip_consent, scopes, redirect_uris, token_endpoint_auth_method, grant_types, response_types, require_pkce, application_type, created_at, updated_at, name) VALUES (?1, ?1, ?2, 0, 1, '["openid","email","profile"]', ?3, 'client_secret_post', '["authorization_code"]', '["code"]', 1, 'web', 1, 1, 'Access')`,
    )
      .bind(CLIENT_ID, await sha256Base64Url(CLIENT_SECRET), JSON.stringify([REDIRECT]))
      .run();
  });

  it("issues tokens for a live sign-in and records who got them", async () => {
    const email = uniqueEmail("live");
    const user = await createUser(email);
    const answer = await redeem(await authorize((await signIn(user.id)).cookie));
    expect(answer.status).toBe(200);
    const audited = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_event WHERE email = ? AND event = 'TokenIssued' AND outcome = 'Succeeded'",
    )
      .bind(email)
      .first<{ count: number }>();
    expect(audited?.count).toBe(1);
  });

  it("refuses a code whose session was deleted after it was issued", async () => {
    const user = await createUser(uniqueEmail("signed-out"));
    const session = await signIn(user.id);
    const code = await authorize(session.cookie);
    await testEnv.DB.prepare("DELETE FROM session WHERE id = ?").bind(session.sessionId).run();
    const answer = await redeem(code);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a code for a user banned after it was issued", async () => {
    const user = await createUser(uniqueEmail("banned"));
    const code = await authorize((await signIn(user.id)).cookie);
    await testEnv.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(user.id).run();
    const answer = await redeem(code);
    expect(answer.status).toBe(400);
  });
});
