import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ISSUER } from "../src/bootstrap";
import { issueInvite, revokeInvite } from "../src/routes/app";
import {
  INVITE_RENEWAL_LIMIT_MS,
  issueResetLink,
  requestFreshLink,
  requestReset,
} from "../src/routes/reset";
import {
  call,
  createUser,
  fromAddress,
  linkIn,
  mailDeps,
  mailsTo,
  PASSWORD,
  randomAddress,
  sent,
  settle,
  testEnv,
  uniqueEmail,
} from "./helpers";

const freshLink = async (token: string, address = randomAddress()): Promise<void> => {
  const answer = await requestFreshLink(mailDeps(), fromAddress(address), { token });
  expect(answer.status).toBe(202);
  await settle();
};

const expire = (table: "invite" | "reset_link", email: string) =>
  testEnv.DB.prepare(`UPDATE ${table} SET expires_at = ? WHERE email = ?`)
    .bind(Date.now() - 1000, email)
    .run();

const sentCount = (): number => sent.length;

const inviteLookup = (token: string) => call("/app/invite/lookup", { body: { token } });

describe("fresh link", () => {
  it("mails a new 7-day invite for an expired invite", async () => {
    const email = uniqueEmail("expired-invite");
    const { token } = await issueInvite(testEnv.DB, email, "operator@remit.test");
    await expire("invite", email);
    await freshLink(token);
    const fresh = linkIn(mailsTo(email).at(-1), "/invite");
    expect(fresh).toBeDefined();
    expect((await inviteLookup(fresh ?? "")).status).toBe(200);
    expect((await inviteLookup(token)).status).toBe(410);
  });

  it("mails a new invite for a replaced invite and stops the one that replaced it", async () => {
    const email = uniqueEmail("replaced-invite");
    const older = await issueInvite(testEnv.DB, email, "operator@remit.test");
    const newer = await issueInvite(testEnv.DB, email, "operator@remit.test");
    await freshLink(older.token);
    const fresh = linkIn(mailsTo(email).at(-1), "/invite");
    expect((await inviteLookup(fresh ?? "")).status).toBe(200);
    expect((await inviteLookup(newer.token)).status).toBe(410);
  });

  it("mails a reset link for a redeemed invite", async () => {
    const email = uniqueEmail("redeemed-invite");
    const { token } = await issueInvite(testEnv.DB, email, "operator@remit.test");
    expect((await call("/app/invite/redeem", { body: { token } })).status).toBe(200);
    await createUser(email, { password: PASSWORD });
    await freshLink(token);
    const mails = mailsTo(email);
    expect(mails).toHaveLength(1);
    expect(linkIn(mails[0], "/reset/password")).toBeDefined();
  });

  it("mails a new reset link for a used or expired one", async () => {
    const email = uniqueEmail("dead-reset");
    const user = await createUser(email, { password: PASSWORD });
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    await expire("reset_link", email);
    await freshLink(token);
    const fresh = linkIn(mailsTo(email).at(-1), "/reset/password");
    expect(fresh).toBeDefined();
    expect((await call("/app/reset/lookup", { body: { token: fresh } })).status).toBe(200);
  });

  it("mails nothing for a revoked invite, a disabled account or an unknown token", async () => {
    const revoked = uniqueEmail("revoked");
    const issued = await issueInvite(testEnv.DB, revoked, "operator@remit.test");
    await revokeInvite(testEnv.DB, issued.inviteId);
    await freshLink(issued.token);
    expect(mailsTo(revoked)).toHaveLength(0);

    const shadowed = uniqueEmail("shadowed");
    const older = await issueInvite(testEnv.DB, shadowed, "operator@remit.test");
    const newest = await issueInvite(testEnv.DB, shadowed, "operator@remit.test");
    await revokeInvite(testEnv.DB, newest.inviteId);
    await freshLink(older.token);
    expect(mailsTo(shadowed)).toHaveLength(0);

    const disabled = uniqueEmail("disabled");
    const user = await createUser(disabled, { password: PASSWORD });
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    await testEnv.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(user.id).run();
    await freshLink(token);
    expect(mailsTo(disabled)).toHaveLength(0);

    const before = sentCount();
    await freshLink("an-unknown-token");
    expect(sentCount()).toBe(before);
  });

  it("stops renewing an invite 30 days after it was first sent", async () => {
    const email = uniqueEmail("old-invite");
    const first = await issueInvite(testEnv.DB, email, "operator@remit.test");
    const firstIssuedAt = Date.now() - INVITE_RENEWAL_LIMIT_MS + 60_000;
    await testEnv.DB.prepare("UPDATE invite SET first_issued_at = ? WHERE email = ?")
      .bind(firstIssuedAt, email)
      .run();
    await expire("invite", email);
    await freshLink(first.token);
    const renewed = linkIn(mailsTo(email).at(-1), "/invite");
    expect(renewed).toBeDefined();
    const row = await testEnv.DB.prepare(
      "SELECT first_issued_at FROM invite WHERE email = ? AND state = 'Open'",
    )
      .bind(email)
      .first<{ first_issued_at: number }>();
    expect(row?.first_issued_at).toBe(firstIssuedAt);

    await testEnv.DB.prepare("UPDATE invite SET first_issued_at = ? WHERE email = ?")
      .bind(Date.now() - INVITE_RENEWAL_LIMIT_MS - 1000, email)
      .run();
    await expire("invite", email);
    await freshLink(renewed ?? "");
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("does not renew a bootstrap invite whose address is no longer an operator", async () => {
    const email = uniqueEmail("former-operator");
    const { token } = await issueInvite(testEnv.DB, email, BOOTSTRAP_ISSUER);
    await expire("invite", email);
    await freshLink(token);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("shares the reset quota of the address", async () => {
    const address = randomAddress();
    const email = uniqueEmail("quota");
    const user = await createUser(email, { password: PASSWORD });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      requestReset(mailDeps(), fromAddress(address), { email: uniqueEmail("filler") });
    }
    await settle();
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    await expire("reset_link", email);
    await freshLink(token, address);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("shares the reset quota of the account", async () => {
    const email = uniqueEmail("account-quota");
    const user = await createUser(email, { password: PASSWORD });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      requestReset(mailDeps(), fromAddress(), { email });
    }
    await settle();
    const before = mailsTo(email).length;
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    await freshLink(token);
    expect(mailsTo(email)).toHaveLength(before);
  });
});
