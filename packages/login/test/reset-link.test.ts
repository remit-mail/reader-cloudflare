import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { issueResetLink, RESET_LINK_LIFE_MS, requestReset } from "../src/routes/reset";
import {
  call,
  cookiesOf,
  createUser,
  fromAddress,
  linkIn,
  mailDeps,
  mailsTo,
  mockPwnedPasswords,
  PASSWORD,
  settle,
  signIn,
  testEnv,
  uniqueEmail,
} from "./helpers";

const FRESH = "a long and fresh password for the reset";

const lookup = (token: string) => call("/app/reset/lookup", { body: { token } });

const redeem = (token: string, password = FRESH) =>
  call("/app/reset/password", { body: { token, password } });

const requestLink = async (email: string): Promise<string> => {
  const answer = requestReset(mailDeps(), fromAddress(), { email });
  expect(answer.status).toBe(202);
  await settle();
  const token = linkIn(mailsTo(email).at(-1), "/reset/password");
  if (token === undefined) throw new Error(`no reset link mailed to ${email}`);
  return token;
};

describe("reset link", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mails a link that works once for 1 hour and stores only its hash", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("reset");
    await createUser(email, { password: PASSWORD });
    const token = await requestLink(email);

    const mail = mailsTo(email).at(-1)?.text ?? "";
    expect(mail).toContain("works once");
    expect(mail).toContain("1 hour");

    const rows = await testEnv.DB.prepare("SELECT * FROM reset_link WHERE email = ?")
      .bind(email)
      .all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(rows.results)).not.toContain(token);

    expect((await lookup(token)).status).toBe(200);
    expect(await (await lookup(token)).json()).toEqual({ email });

    const reset = await redeem(token);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ secondStep: "none" });
    expect(cookiesOf(reset)).toContain("session_token");

    expect((await redeem(token, "another long password to try")).status).toBe(410);
    expect((await lookup(token)).status).toBe(410);

    const signedIn = await call("/api/auth/sign-in/email", { body: { email, password: FRESH } });
    expect(signedIn.status).toBe(200);
  });

  it("writes audit records that hold no token", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("audited");
    await createUser(email, { password: PASSWORD });
    const token = await requestLink(email);
    expect((await redeem(token)).status).toBe(200);
    const rows = await testEnv.DB.prepare("SELECT * FROM audit_event WHERE email = ? ORDER BY at")
      .bind(email)
      .all<{ event: string; outcome: string }>();
    expect(rows.results.map((row) => `${row.event} ${row.outcome}`)).toEqual(
      expect.arrayContaining(["ResetRequested Succeeded", "PasswordReset Succeeded"]),
    );
    expect(JSON.stringify(rows.results)).not.toContain(token);
  });

  it("expires after 1 hour", async () => {
    const email = uniqueEmail("expiry");
    const user = await createUser(email, { password: PASSWORD });
    const now = Date.now();
    const token = await issueResetLink(testEnv.DB, user, now);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + RESET_LINK_LIFE_MS - 1000);
    expect((await lookup(token)).status).toBe(200);
    vi.setSystemTime(now + RESET_LINK_LIFE_MS + 1000);
    expect((await lookup(token)).status).toBe(410);
    expect((await redeem(token)).status).toBe(410);
  });

  it("stops the older link once a newer one is sent", async () => {
    const email = uniqueEmail("replaced");
    await createUser(email, { password: PASSWORD });
    const older = await requestLink(email);
    const newer = await requestLink(email);
    expect(newer).not.toBe(older);
    expect((await lookup(older)).status).toBe(410);
    expect((await lookup(newer)).status).toBe(200);
  });

  it("signs out every other device", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("devices");
    const user = await createUser(email, { password: PASSWORD });
    const other = await signIn(user.id);
    const token = await requestLink(email);
    expect((await redeem(token)).status).toBe(200);
    const session = await call("/api/auth/get-session", { cookie: other.cookie });
    expect(await session.json()).toBeNull();
  });

  it("sends nothing to a disabled account", async () => {
    const email = uniqueEmail("disabled");
    await createUser(email, { password: PASSWORD });
    await testEnv.DB.prepare("UPDATE user SET banned = 1 WHERE email = ?").bind(email).run();
    requestReset(mailDeps(), fromAddress(), { email });
    await settle();
    expect(mailsTo(email)).toHaveLength(0);
  });
});
