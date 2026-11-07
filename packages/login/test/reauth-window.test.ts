import { afterEach, describe, expect, it, vi } from "vitest";
import { REAUTH_WINDOW_MS } from "../src/routes/app";
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
  welcome,
} from "./helpers";

const enroll = (cookie: string, env = testEnv) =>
  call("/app/second-step/app", { cookie, body: {}, env });

const codeOf = async (response: Response): Promise<string | undefined> =>
  ((await response.json()) as { code?: string }).code;

describe("confirmed window after set password", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets the new session add an app with no password", async () => {
    mockPwnedPasswords([]);
    const cookie = await welcome(uniqueEmail("window"), PASSWORD);
    const answer = await enroll(cookie);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { totpURI?: string; backupCodes?: string[] };
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.backupCodes).toHaveLength(10);
    const passkey = await call("/api/auth/passkey/generate-register-options", { cookie });
    expect(passkey.status).toBe(200);
  });

  it("binds the window to the one session it created", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("bound");
    await welcome(email, PASSWORD);
    const user = await testEnv.DB.prepare("SELECT id FROM user WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    const other = await signIn(user?.id ?? "");
    const answer = await enroll(other.cookie);
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("REAUTHENTICATE");
  });

  it("ends 5 minutes after set password, and enrolling does not extend it", async () => {
    mockPwnedPasswords([]);
    const start = Date.now();
    const cookie = await welcome(uniqueEmail("lapse"), PASSWORD);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + REAUTH_WINDOW_MS - 30_000);
    expect((await enroll(cookie)).status).toBe(200);
    vi.setSystemTime(start + REAUTH_WINDOW_MS + 1000);
    const late = await enroll(cookie);
    expect(late.status).toBe(403);
    expect(await codeOf(late)).toBe("REAUTHENTICATE");
  });

  it("does not confirm the session a reset creates", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("reset-session");
    const user = await createUser(email, { password: PASSWORD });
    const token = await issueResetLink(testEnv.DB, user, Date.now());
    const reset = await call("/app/reset/password", {
      body: { token, password: "a long and fresh password for the reset" },
    });
    expect(reset.status).toBe(200);
    const answer = await enroll(cookiesOf(reset));
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("REAUTHENTICATE");
  });

  it("never satisfies an admin step-up", async () => {
    mockPwnedPasswords([]);
    const operator = uniqueEmail("operator");
    const env = { ...testEnv, OPERATOR_EMAILS: operator };
    const cookie = await welcome(operator, PASSWORD, env);
    const challenge = await call("/app/admin/challenge", {
      cookie,
      env,
      body: { action: "Invite", targetEmail: uniqueEmail("target") },
    });
    expect(challenge.status).toBe(403);
    const action = await call("/app/admin/action", {
      cookie,
      env,
      body: {
        adminChallengeId: crypto.randomUUID(),
        action: "Invite",
        targetEmail: uniqueEmail("target"),
      },
    });
    expect(action.status).not.toBe(200);
  });

  it("still asks a confirmed operator for the step-up factor", async () => {
    const operator = uniqueEmail("app-operator");
    const env = { ...testEnv, OPERATOR_EMAILS: operator };
    const user = await createUser(operator, { totp: true, password: PASSWORD });
    const session = await signIn(user.id);
    await testEnv.DB.prepare("UPDATE session SET reauthenticated_at = ? WHERE id = ?")
      .bind(Date.now(), session.sessionId)
      .run();
    const target = uniqueEmail("invitee");
    const opened = await call("/app/admin/challenge", {
      cookie: session.cookie,
      env,
      body: { action: "Invite", targetEmail: target },
    });
    expect(opened.status).toBe(200);
    const { adminChallengeId } = (await opened.json()) as { adminChallengeId: string };
    const action = await call("/app/admin/action", {
      cookie: session.cookie,
      env,
      body: { adminChallengeId, action: "Invite", targetEmail: target },
    });
    expect(action.status).not.toBe(200);
    const invited = await testEnv.DB.prepare("SELECT 1 FROM invite WHERE email = ?")
      .bind(target)
      .first();
    expect(invited).toBeNull();
  });
});
