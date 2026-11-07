import { afterEach, describe, expect, it, vi } from "vitest";
import { issueInvite } from "../src/routes/app";
import { issueResetLink } from "../src/routes/reset";
import {
  call,
  cookiesOf,
  createUser,
  mockPwnedPasswords,
  PASSWORD,
  signIn,
  testEnv,
  uniqueEmail,
} from "./helpers";

const PWNED = "password1234567";

const welcome = async (password: string) => {
  const email = uniqueEmail("welcome");
  const { token } = await issueInvite(testEnv.DB, email, "test");
  const redeemed = await call("/app/invite/redeem", { body: { token } });
  const answer = await call("/app/welcome/password", {
    cookie: cookiesOf(redeemed),
    body: { password },
  });
  const user = await testEnv.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first();
  return { status: answer.status, created: user !== null };
};

describe("password rules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts 12 to 128 characters and refuses 11 and 129", async () => {
    mockPwnedPasswords([]);
    expect(await welcome("a".repeat(11))).toEqual({ status: 400, created: false });
    expect(await welcome("b".repeat(129))).toEqual({ status: 400, created: false });
    expect(await welcome("c".repeat(12))).toEqual({ status: 200, created: true });
    expect(await welcome("d".repeat(128))).toEqual({ status: 200, created: true });
  });

  it("refuses a pwned password on welcome, reset and change", async () => {
    mockPwnedPasswords([PWNED]);
    expect((await welcome(PWNED)).created).toBe(false);

    const email = uniqueEmail("change");
    const user = await createUser(email, { password: PASSWORD });
    const session = await signIn(user.id);
    const confirmed = await call("/app/security/confirm", {
      cookie: session.cookie,
      body: { password: PASSWORD },
    });
    expect(confirmed.status).toBe(200);
    const changed = await call("/api/auth/change-password", {
      cookie: session.cookie,
      body: { currentPassword: PASSWORD, newPassword: PWNED },
    });
    expect(changed.status).toBe(400);

    const token = await issueResetLink(testEnv.DB, user, Date.now());
    const reset = await call("/app/reset/password", { body: { token, password: PWNED } });
    expect(reset.status).toBe(400);
  });

  it("leaves the reset link valid after a refused password", async () => {
    mockPwnedPasswords([PWNED]);
    const user = await createUser(uniqueEmail("refused"), { password: PASSWORD });
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    for (const password of ["a".repeat(11), "b".repeat(129), PWNED]) {
      const refused = await call("/app/reset/password", { body: { token, password } });
      expect(refused.status).toBe(400);
    }
    expect((await call("/app/reset/lookup", { body: { token } })).status).toBe(200);
    const reset = await call("/app/reset/password", {
      body: { token, password: "a fine and long new password" },
    });
    expect(reset.status).toBe(200);
  });

  it("signs the invitee in so the second step can still confirm the password", async () => {
    mockPwnedPasswords([]);
    const password = "a fresh password for the welcome flow";
    const { token } = await issueInvite(testEnv.DB, uniqueEmail("second-step"), "test");
    const redeemed = await call("/app/invite/redeem", { body: { token } });
    const welcomed = await call("/app/welcome/password", {
      cookie: cookiesOf(redeemed),
      body: { password },
    });
    expect(welcomed.status).toBe(200);
    const confirmed = await call("/app/security/confirm", {
      cookie: cookiesOf(welcomed),
      body: { password },
    });
    expect(confirmed.status).toBe(200);
  });

  it("sets nothing when the range API is unreachable", async () => {
    mockPwnedPasswords("unreachable");
    const outcome = await welcome("an otherwise fine password");
    expect(outcome.created).toBe(false);
    expect(outcome.status).toBeGreaterThanOrEqual(500);
  });
});
