import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapOperators } from "../src/bootstrap";
import { mailerOf } from "../src/capture";
import { configOf } from "../src/config";
import { issueInvite } from "../src/routes/app";
import { requestFreshLink } from "../src/routes/reset";
import {
  addPasskeyRow,
  call,
  createUser,
  fromAddress,
  mailDeps,
  mailsTo,
  OPERATOR,
  OTHER_OPERATOR,
  PASSWORD,
  type SignedIn,
  settle,
  signIn,
  testEnv,
  totpCode,
  uniqueEmail,
} from "./helpers";

const STEP_MS = 30_000;
const MID_STEP = Math.floor(Date.UTC(2026, 10, 7, 12) / STEP_MS) * STEP_MS + 10_000;

const challenge = (operator: SignedIn, action: string, targetEmail: string) =>
  call("/app/admin/challenge", { cookie: operator.cookie, body: { action, targetEmail } });

const openTotpChallenge = async (operator: SignedIn, action: string, targetEmail: string) => {
  const response = await challenge(operator, action, targetEmail);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { adminChallengeId: string; method: string };
  expect(body.method).toBe("Totp");
  return body.adminChallengeId;
};

const act = (
  operator: SignedIn,
  adminChallengeId: string,
  action: string,
  targetEmail: string,
  code: string,
) =>
  call("/app/admin/action", {
    cookie: operator.cookie,
    body: { adminChallengeId, action, targetEmail, totpCode: code },
  });

const isBanned = async (email: string): Promise<boolean> => {
  const row = await testEnv.DB.prepare("SELECT banned FROM user WHERE email = ?")
    .bind(email)
    .first<{ banned: number | null }>();
  return Boolean(row?.banned);
};

const sessionsOf = async (email: string): Promise<number> => {
  const row = await testEnv.DB.prepare(
    "SELECT COUNT(*) AS count FROM session JOIN user ON user.id = session.user_id WHERE user.email = ?",
  )
    .bind(email)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const count = async (sql: string, ...values: unknown[]): Promise<number> => {
  const row = await testEnv.DB.prepare(sql)
    .bind(...values)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

describe("admin step-up", () => {
  let operator: SignedIn;
  let alice: string;
  let bob: string;
  let step: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    step = Math.floor(MID_STEP / STEP_MS) + Math.floor(Math.random() * 1_000_000);
    vi.setSystemTime(step * STEP_MS + 10_000);
    await testEnv.DB.prepare("DELETE FROM user WHERE email IN (?, ?)")
      .bind(OPERATOR, OTHER_OPERATOR)
      .run();
    const operatorUser = await createUser(OPERATOR, { totp: true });
    operator = await signIn(operatorUser.id);
    alice = uniqueEmail("alice");
    bob = uniqueEmail("bob");
    await signIn((await createUser(alice)).id);
    await signIn((await createUser(bob)).id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers 404 to a signed-in non-operator and to no session", async () => {
    const outsider = await signIn((await createUser(uniqueEmail("x"))).id);
    for (const cookie of [outsider.cookie, undefined]) {
      expect((await call("/admin", cookie ? { cookie } : {})).status).toBe(404);
      expect((await call("/admin/audit?days=7", cookie ? { cookie } : {})).status).toBe(404);
      for (const path of ["/app/admin/challenge", "/app/admin/action"]) {
        const answer = await call(path, {
          ...(cookie ? { cookie } : {}),
          body: { action: "Disable", targetEmail: alice },
        });
        expect(answer.status).toBe(404);
      }
    }
  });

  it("shows an operator without a factor only the enroll page and refuses actions", async () => {
    await testEnv.DB.prepare("DELETE FROM user WHERE email = ?").bind(OPERATOR).run();
    const bare = await signIn((await createUser(OPERATOR)).id);
    const page = await call("/admin", { cookie: bare.cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Add a second factor");
    const opened = await call("/app/admin/challenge", {
      cookie: bare.cookie,
      body: { action: "Disable", targetEmail: alice },
    });
    expect(opened.status).toBe(403);
  });

  it("runs a challenge only for its own action and target", async () => {
    const id = await openTotpChallenge(operator, "Disable", alice);
    const swapped = await act(operator, id, "ResetFactors", bob, await totpCode(step));
    expect(swapped.status).toBe(403);
    expect(await isBanned(alice)).toBe(false);
    expect(await isBanned(bob)).toBe(false);
    expect(await sessionsOf(bob)).toBe(1);
  });

  it("runs a challenge once", async () => {
    const id = await openTotpChallenge(operator, "Disable", alice);
    const first = await act(operator, id, "Disable", alice, await totpCode(step));
    expect(first.status).toBe(200);
    expect(await isBanned(alice)).toBe(true);
    expect(await sessionsOf(alice)).toBe(0);

    vi.setSystemTime((step + 1) * STEP_MS + 10_000);
    const again = await act(operator, id, "Disable", alice, await totpCode(step + 1));
    expect(again.status).toBe(403);
  });

  it("keeps one open challenge per operator", async () => {
    const first = await openTotpChallenge(operator, "Disable", alice);
    await openTotpChallenge(operator, "Disable", bob);
    const stale = await act(operator, first, "Disable", alice, await totpCode(step));
    expect(stale.status).toBe(403);
    expect(await isBanned(alice)).toBe(false);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM admin_challenge WHERE operator_user_id = ? AND state = 'Open'",
        operator.userId,
      ),
    ).toBe(1);
  });

  it("refuses a challenge after two minutes and from another session", async () => {
    const stale = await openTotpChallenge(operator, "SignOutEverywhere", alice);
    vi.setSystemTime(step * STEP_MS + 10_000 + 2 * 60_000 + 1);
    const late = await act(
      operator,
      stale,
      "SignOutEverywhere",
      alice,
      await totpCode(Math.floor(Date.now() / STEP_MS)),
    );
    expect(late.status).toBe(403);

    const fresh = await openTotpChallenge(operator, "SignOutEverywhere", alice);
    const otherSession = await signIn(operator.userId);
    const elsewhere = await act(
      otherSession,
      fresh,
      "SignOutEverywhere",
      alice,
      await totpCode(Math.floor(Date.now() / STEP_MS)),
    );
    expect(elsewhere.status).toBe(403);
    expect(await sessionsOf(alice)).toBe(1);
  });

  it("refuses a TOTP step that was already used, also when two requests race", async () => {
    const code = await totpCode(step);
    const first = await openTotpChallenge(operator, "SignOutEverywhere", alice);
    expect((await act(operator, first, "SignOutEverywhere", alice, code)).status).toBe(200);
    const second = await openTotpChallenge(operator, "Disable", bob);
    expect((await act(operator, second, "Disable", bob, code)).status).toBe(403);
    expect(await isBanned(bob)).toBe(false);

    vi.setSystemTime((step + 1) * STEP_MS + 10_000);
    const raceCode = await totpCode(step + 1);
    const raced = await openTotpChallenge(operator, "Disable", bob);
    const statuses = await Promise.all([
      act(operator, raced, "Disable", bob, raceCode),
      act(operator, raced, "Disable", bob, raceCode),
    ]).then((responses) => responses.map((response) => response.status).sort());
    expect(statuses).toEqual([200, 403]);
  });

  it("runs nothing when the proof fails", async () => {
    const id = await openTotpChallenge(operator, "Disable", alice);
    const wrong = (await totpCode(step)) === "000000" ? "111111" : "000000";
    const answer = await act(operator, id, "Disable", alice, wrong);
    expect(answer.status).toBe(403);
    expect(await isBanned(alice)).toBe(false);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND email = ? AND event = 'AdminStepUp' AND outcome = 'Refused'",
        OPERATOR,
        alice,
      ),
    ).toBe(1);
  });

  it("slows step-ups after repeated failed proofs, apart from anonymous password failures", async () => {
    const wrong = (await totpCode(step)) === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await call("/api/auth/sign-in/email", {
        body: { email: OPERATOR, password: "not it at all" },
      });
    }
    const unaffected = await openTotpChallenge(operator, "SignOutEverywhere", alice);
    expect(
      (await act(operator, unaffected, "SignOutEverywhere", alice, await totpCode(step))).status,
    ).toBe(200);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const id = await openTotpChallenge(operator, "Disable", alice);
      expect((await act(operator, id, "Disable", alice, wrong)).status).toBe(403);
    }
    const id = await openTotpChallenge(operator, "Disable", alice);
    const delayed = await act(operator, id, "Disable", alice, await totpCode(step));
    expect(delayed.status).toBe(429);
    expect(await isBanned(alice)).toBe(false);
  });

  it("refuses an action on another operator", async () => {
    const other = await createUser(OTHER_OPERATOR, { totp: true });
    await signIn(other.id);
    for (const action of ["Disable", "ResetFactors", "SignOutEverywhere"]) {
      const answer = await challenge(operator, action, OTHER_OPERATOR);
      expect(answer.status).toBe(403);
    }
    const self = await challenge(operator, "Disable", OPERATOR);
    expect(self.status).toBe(403);
    expect(await isBanned(OTHER_OPERATOR)).toBe(false);
    expect(await sessionsOf(OTHER_OPERATOR)).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND email = ? AND outcome = 'Refused'",
        OPERATOR,
        OTHER_OPERATOR,
      ),
    ).toBe(3);
  });

  it("revokes a pending invite so it neither redeems nor renews", async () => {
    const invitee = uniqueEmail("revoked-invite");
    const { token } = await issueInvite(testEnv.DB, invitee, OPERATOR);
    const stale = uniqueEmail("expired-invite");
    await issueInvite(testEnv.DB, stale, OPERATOR);
    await testEnv.DB.prepare("UPDATE invite SET expires_at = ? WHERE email = ?")
      .bind(Date.now() - 1000, stale)
      .run();
    const page = await (await call("/admin", { cookie: operator.cookie })).text();
    expect(page).toContain(`data-action="RevokeInvite" data-target="${invitee}"`);
    expect(page).toContain(`data-action="RevokeInvite" data-target="${stale}"`);

    const id = await openTotpChallenge(operator, "RevokeInvite", invitee);
    const revoked = await act(operator, id, "RevokeInvite", invitee, await totpCode(step));
    expect(revoked.status).toBe(200);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND email = ? AND event = 'InviteRevoked' AND outcome = 'Succeeded'",
        OPERATOR,
        invitee,
      ),
    ).toBe(1);

    expect((await call("/app/invite/redeem", { body: { token } })).status).toBe(410);
    const fresh = await requestFreshLink(mailDeps(), fromAddress(), { token });
    expect(fresh.status).toBe(202);
    await settle();
    expect(mailsTo(invitee)).toHaveLength(0);
  });

  it("keeps an old signing key on rotate and drops every key on revoke", async () => {
    await testEnv.DB.prepare("DELETE FROM jwks").run();
    expect((await call("/api/auth/jwks")).status).toBe(200);
    const keys = () => count("SELECT COUNT(*) AS count FROM jwks");
    expect(await keys()).toBe(1);

    const rotate = await openTotpChallenge(operator, "RotateKeys", OPERATOR);
    expect((await act(operator, rotate, "RotateKeys", OPERATOR, await totpCode(step))).status).toBe(
      200,
    );
    expect(await keys()).toBe(1);

    vi.setSystemTime((step + 1) * STEP_MS + 10_000);
    const revoke = await openTotpChallenge(operator, "RevokeKeys", OPERATOR);
    const revoked = await act(operator, revoke, "RevokeKeys", OPERATOR, await totpCode(step + 1));
    expect(revoked.status).toBe(200);
    expect(await keys()).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND event = 'KeysRevoked'",
        OPERATOR,
      ),
    ).toBe(1);
  });

  it("refuses a password alone on security confirm for a user with a factor", async () => {
    const withApp = await createUser(uniqueEmail("app"), { totp: true, password: PASSWORD });
    const withPasskey = await createUser(uniqueEmail("key"), { password: PASSWORD });
    await addPasskeyRow(withPasskey.id, crypto.randomUUID());
    for (const user of [withApp, withPasskey]) {
      const session = await signIn(user.id);
      const answer = await call("/app/security/confirm", {
        cookie: session.cookie,
        body: { password: PASSWORD },
      });
      expect(answer.status).toBe(403);
    }
  });

  it("accepts an app code on security confirm once per time step", async () => {
    const user = await createUser(uniqueEmail("replay"), { totp: true, password: PASSWORD });
    const session = await signIn(user.id);
    const code = await totpCode(step);
    const confirm = () =>
      call("/app/security/confirm", { cookie: session.cookie, body: { totpCode: code } });
    expect((await confirm()).status).toBe(200);
    expect((await confirm()).status).toBe(401);
  });

  it("escapes stored values on the admin and audit pages", async () => {
    const hostile = `<script>alert(1)</script>${crypto.randomUUID()}@remit.test`;
    await createUser(hostile);
    await testEnv.DB.prepare(
      "INSERT INTO audit_event (audit_event_id, at, actor, email, address, event, outcome, client_id) VALUES (?, ?, 'self', ?, '<b>x</b>', 'SignIn', 'Succeeded', 'none')",
    )
      .bind(crypto.randomUUID(), Date.now(), hostile)
      .run();
    for (const path of ["/admin", "/admin/audit?days=7"]) {
      const body = await (await call(path, { cookie: operator.cookie })).text();
      expect(body).not.toContain("<script>alert(1)");
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  it("refuses requests that carry Access credentials", async () => {
    const answer = await call("/admin", {
      cookie: operator.cookie,
      headers: { "CF-Access-Client-Id": "agent" },
    });
    expect(answer.status).toBe(403);
  });

  it("bootstraps operator invites only while no operator has an account", async () => {
    const config = configOf(testEnv);
    expect(await bootstrapOperators(testEnv.DB, mailerOf(testEnv), config, Date.now())).toBe(0);
    await testEnv.DB.prepare("DELETE FROM user WHERE email IN (?, ?)")
      .bind(OPERATOR, OTHER_OPERATOR)
      .run();
    await testEnv.DB.prepare("DELETE FROM invite WHERE email IN (?, ?)")
      .bind(OPERATOR, OTHER_OPERATOR)
      .run();
    expect(await bootstrapOperators(testEnv.DB, mailerOf(testEnv), config, Date.now())).toBe(2);
    expect(await bootstrapOperators(testEnv.DB, mailerOf(testEnv), config, Date.now())).toBe(0);
  });
});
