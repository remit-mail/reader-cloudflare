import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  call,
  createUser,
  OPERATOR,
  OTHER_OPERATOR,
  type SignedIn,
  signIn,
  testEnv,
  totpCode,
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

const act = async (
  operator: SignedIn,
  adminChallengeId: string,
  action: string,
  targetEmail: string,
  totpCode: string,
) =>
  call("/app/admin/action", {
    cookie: operator.cookie,
    body: { adminChallengeId, action, targetEmail, totpCode },
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
    alice = `alice-${crypto.randomUUID()}@remit.test`;
    bob = `bob-${crypto.randomUUID()}@remit.test`;
    await signIn((await createUser(alice)).id);
    await signIn((await createUser(bob)).id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers 404 to a signed-in non-operator and to no session", async () => {
    const outsider = await signIn((await createUser(`x-${crypto.randomUUID()}@remit.test`)).id);
    for (const cookie of [outsider.cookie, undefined]) {
      expect((await call("/admin", cookie ? { cookie } : {})).status).toBe(404);
      expect((await call("/admin/audit?days=7", cookie ? { cookie } : {})).status).toBe(404);
      const opened = await call("/app/admin/challenge", {
        ...(cookie ? { cookie } : {}),
        body: { action: "Disable", targetEmail: alice },
      });
      expect(opened.status).toBe(404);
    }
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
    const [one, two] = await Promise.all([
      openTotpChallenge(operator, "Disable", bob),
      openTotpChallenge(operator, "ResetFactors", alice),
    ]);
    const statuses = await Promise.all([
      act(operator, one, "Disable", bob, raceCode),
      act(operator, two, "ResetFactors", alice, raceCode),
    ]).then((responses) => responses.map((response) => response.status).sort());
    expect(statuses).toEqual([200, 403]);
  });

  it("runs nothing when the proof fails", async () => {
    const id = await openTotpChallenge(operator, "Disable", alice);
    const wrong = (await totpCode(step)) === "000000" ? "111111" : "000000";
    const answer = await act(operator, id, "Disable", alice, wrong);
    expect(answer.status).toBe(403);
    expect(await isBanned(alice)).toBe(false);
    const refused = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND email = ? AND event = 'AdminStepUp' AND outcome = 'Refused'",
    )
      .bind(OPERATOR, alice)
      .first<{ count: number }>();
    expect(refused?.count).toBe(1);
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
    const audited = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_event WHERE actor = ? AND email = ? AND outcome = 'Refused'",
    )
      .bind(OPERATOR, OTHER_OPERATOR)
      .first<{ count: number }>();
    expect(audited?.count).toBe(3);
  });

  it("refuses requests that carry Access credentials", async () => {
    const answer = await call("/admin", {
      cookie: operator.cookie,
      headers: { "CF-Access-Client-Id": "agent" },
    });
    expect(answer.status).toBe(403);
  });
});
