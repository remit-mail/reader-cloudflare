import { afterEach, describe, expect, it, vi } from "vitest";
import { issueResetLink } from "../src/routes/reset";
import {
  addPasskeyRow,
  call,
  cookiesOf,
  createUser,
  mockPwnedPasswords,
  PASSWORD,
  signIn,
  testEnv,
  totpCode,
  uniqueEmail,
} from "./helpers";

const sessionCount = async (userId: string): Promise<number> => {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM session WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const passkeyUser = async () => {
  const email = uniqueEmail("passkey");
  const user = await createUser(email, { password: PASSWORD });
  await addPasskeyRow(user.id, `cred-${crypto.randomUUID()}`);
  return { email, user };
};

const expectSecondStep = async (email: string, password: string, userId: string) => {
  const answer = await call("/api/auth/sign-in/email", { body: { email, password } });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ secondStep: ["passkey"] });
  expect(cookiesOf(answer)).not.toContain("session_token");
  expect(await sessionCount(userId)).toBe(0);
  return answer;
};

describe("password path second step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates no session from a correct password for a passkey user", async () => {
    const { email, user } = await passkeyUser();
    await expectSecondStep(email, PASSWORD, user.id);
  });

  it("refuses a passkey assertion of another account on the second step", async () => {
    const { email, user } = await passkeyUser();
    const other = await createUser(uniqueEmail("other"));
    const otherCredential = `cred-${crypto.randomUUID()}`;
    await addPasskeyRow(other.id, otherCredential);
    const pending = await expectSecondStep(email, PASSWORD, user.id);
    const answer = await call("/api/auth/passkey/verify-authentication", {
      cookie: cookiesOf(pending),
      body: {
        response: { id: otherCredential, rawId: otherCredential, type: "public-key", response: {} },
      },
    });
    expect(answer.status).toBe(403);
    expect(await sessionCount(other.id)).toBe(0);
  });

  it("creates no session from a reset by link for a passkey user", async () => {
    mockPwnedPasswords([]);
    const { email, user } = await passkeyUser();
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    const fresh = "a brand new long password";
    const reset = await call("/app/reset/password", { body: { token, password: fresh } });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ secondStep: "passkey" });
    expect(cookiesOf(reset)).not.toContain("session_token");
    expect(await sessionCount(user.id)).toBe(0);
    await expectSecondStep(email, fresh, user.id);
  });

  it("asks an app user for the code after a reset by link", async () => {
    mockPwnedPasswords([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const step = 61_000_000 + Math.floor(Math.random() * 1_000_000);
      vi.setSystemTime(step * 30_000 + 10_000);
      const user = await createUser(uniqueEmail("app-reset"), { totp: true, password: PASSWORD });
      const token = await issueResetLink(testEnv.DB, user, Date.now());
      const reset = await call("/app/reset/password", {
        body: { token, password: "a brand new long password" },
      });
      expect(reset.status).toBe(200);
      expect(await reset.json()).toEqual({ secondStep: "app" });
      expect(cookiesOf(reset)).not.toContain("session_token");
      expect(await sessionCount(user.id)).toBe(0);
      const verified = await call("/api/auth/two-factor/verify-totp", {
        cookie: cookiesOf(reset),
        body: { code: await totpCode(step) },
      });
      expect(verified.status).toBe(200);
      expect(await sessionCount(user.id)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends a sign-in app code so it cannot confirm a security change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const step = 60_000_000 + Math.floor(Math.random() * 1_000_000);
      vi.setSystemTime(step * 30_000 + 10_000);
      const email = uniqueEmail("app");
      const user = await createUser(email, { totp: true, password: PASSWORD });
      const first = await call("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      expect(((await first.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
        true,
      );
      const code = await totpCode(step);
      const verified = await call("/api/auth/two-factor/verify-totp", {
        cookie: cookiesOf(first),
        body: { code },
      });
      expect(verified.status).toBe(200);
      const session = await signIn(user.id);
      const replay = await call("/app/security/confirm", {
        cookie: session.cookie,
        body: { totpCode: code },
      });
      expect(replay.status).toBe(401);
      expect(((await replay.json()) as { code?: string }).code).toBe("TOTP_STEP_USED");
    } finally {
      vi.useRealTimers();
    }
  });
});
