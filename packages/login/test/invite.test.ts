import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { issueInvite } from "../src/routes/app";
import { call, testEnv } from "./helpers";

const DEAD = 410;

describe("invite redemption", () => {
  let email: string;

  beforeEach(() => {
    email = `invitee-${crypto.randomUUID()}@remit.test`;
  });

  it("stores only the hash and leaves a looked-up invite open", async () => {
    const { token } = await issueInvite(testEnv.DB, email, "test");
    const row = await testEnv.DB.prepare("SELECT token_hash, state FROM invite WHERE email = ?")
      .bind(email)
      .first<{ token_hash: string; state: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.token_hash).not.toContain(token);

    const first = await call("/app/invite/lookup", { body: { token } });
    const second = await call("/app/invite/lookup", { body: { token } });
    expect(await first.json()).toEqual({ email });
    expect(second.status).toBe(200);
  });

  it("redeems once and answers 410 with one message after", async () => {
    const { token } = await issueInvite(testEnv.DB, email, "test");
    const redeemed = await call("/app/invite/redeem", { body: { token } });
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("set-cookie")).toContain("Path=/app/welcome");

    const again = await call("/app/invite/redeem", { body: { token } });
    const lookup = await call("/app/invite/lookup", { body: { token } });
    expect(again.status).toBe(DEAD);
    expect(lookup.status).toBe(DEAD);
    expect(await again.json()).toEqual(await lookup.json());
  });

  it("redeems one of two concurrent requests", async () => {
    const { token } = await issueInvite(testEnv.DB, email, "test");
    const statuses = await Promise.all([
      call("/app/invite/redeem", { body: { token } }),
      call("/app/invite/redeem", { body: { token } }),
    ]).then((responses) => responses.map((response) => response.status).sort());
    expect(statuses).toEqual([200, DEAD]);
  });

  it("refuses a replaced and an expired invite with the same message", async () => {
    const replaced = await issueInvite(testEnv.DB, email, "test");
    await issueInvite(testEnv.DB, email, "test");
    const expired = await issueInvite(testEnv.DB, `late-${email}`, "test");
    await testEnv.DB.prepare("UPDATE invite SET expires_at = ? WHERE invite_id = ?")
      .bind(Date.now() - 1, expired.inviteId)
      .run();
    const unknown = await call("/app/invite/redeem", { body: { token: "not-a-real-token" } });

    const replacedAnswer = await call("/app/invite/redeem", { body: { token: replaced.token } });
    const expiredAnswer = await call("/app/invite/redeem", { body: { token: expired.token } });
    expect([replacedAnswer.status, expiredAnswer.status, unknown.status]).toEqual([
      DEAD,
      DEAD,
      DEAD,
    ]);
    const bodies = await Promise.all([replacedAnswer.json(), expiredAnswer.json(), unknown.json()]);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("creates no account without the grant cookie", async () => {
    const answer = await call("/app/welcome/password", {
      body: { password: "a long enough password" },
    });
    expect(answer.status).toBe(403);
    const users = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM user WHERE email = ?")
      .bind(email)
      .first<{ count: number }>();
    expect(users?.count).toBe(0);
  });
});
