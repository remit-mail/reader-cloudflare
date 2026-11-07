import { describe, expect, it } from "vitest";
import { purgeStatements } from "../src/audit";
import { accountKey, takeResetQuota } from "../src/backoff";
import { call, createUser, PASSWORD, randomAddress, testEnv, uniqueEmail } from "./helpers";

const signInAs = (email: string, password: string, address: string) =>
  call("/api/auth/sign-in/email", { body: { email, password }, address });

const prefix = (): string =>
  `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;

describe("backoff", () => {
  it("slows one /64 guessing across many emails", async () => {
    const network = prefix();
    const statuses: number[] = [];
    for (let host = 1; host <= 7; host += 1) {
      const answer = await signInAs(
        uniqueEmail("nobody"),
        "wrong password!!",
        `${network}::${host}`,
      );
      statuses.push(answer.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 429]);
    expect(statuses[6]).toBe(429);
  });

  it("slows one account guessed from many addresses, for at most two minutes", async () => {
    const email = uniqueEmail("target");
    await createUser(email, { password: PASSWORD });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await signInAs(email, "wrong password!!", randomAddress())).status).toBe(401);
    }
    const blocked = await signInAs(email, PASSWORD, randomAddress());
    expect(blocked.status).toBe(429);
    const { retryAt } = (await blocked.json()) as { retryAt: string };
    expect(Date.parse(retryAt) - Date.now()).toBeLessThanOrEqual(2 * 60_000);
  });

  it("lets passkey sign-in through while both keys are delayed", async () => {
    const email = uniqueEmail("passkey");
    const address = `${prefix()}::1`;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await signInAs(email, "wrong password!!", address);
    }
    expect((await signInAs(email, "wrong password!!", address)).status).toBe(429);
    const passkey = await call("/api/auth/passkey/verify-authentication", {
      body: { response: { id: "unknown", rawId: "unknown", type: "public-key", response: {} } },
      address,
    });
    expect(passkey.status).not.toBe(429);
  });

  it("clears the account key on success", async () => {
    const email = uniqueEmail("clears");
    await createUser(email, { password: PASSWORD });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await signInAs(email, "wrong password!!", randomAddress());
    }
    expect((await signInAs(email, PASSWORD, randomAddress())).status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT attempts FROM auth_attempt WHERE attempt_key = ?")
      .bind((await accountKey(email)).key)
      .first();
    expect(row).toBeNull();
  });

  it("lets at most six of many parallel guesses reach the password check", async () => {
    const email = uniqueEmail("race");
    await createUser(email, { password: PASSWORD });
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => signInAs(email, "wrong password!!", randomAddress())),
    ).then((responses) => responses.map((response) => response.status));
    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(6);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(14);
  });

  it("never raises an account key from an address that is already refused", async () => {
    const victim = uniqueEmail("victim");
    await createUser(victim, { password: PASSWORD });
    const address = `${prefix()}::1`;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await signInAs(uniqueEmail("spray"), "wrong password!!", address);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await signInAs(victim, "wrong password!!", address)).status).toBe(429);
    }
    const row = await testEnv.DB.prepare("SELECT attempts FROM auth_attempt WHERE attempt_key = ?")
      .bind((await accountKey(victim)).key)
      .first();
    expect(row).toBeNull();
    expect((await signInAs(victim, PASSWORD, randomAddress())).status).toBe(200);
  });

  it("keeps the reset quota of an account open to other addresses after one address burns its own", async () => {
    const victim = uniqueEmail("reset-victim");
    const attacker = randomAddress();
    const now = Date.now();
    const answers: boolean[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      answers.push(await takeResetQuota(testEnv.DB, attacker, victim, now));
    }
    expect(answers.filter(Boolean).length).toBe(5);
    expect(await takeResetQuota(testEnv.DB, randomAddress(), victim, now)).toBe(true);
  });

  it("runs the cron cleanup against the migrated schema", async () => {
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO totp_use (user_id, totp_step, used_for, used_at) VALUES (?, 1, 'SignIn', ?)",
      ).bind(crypto.randomUUID(), old),
      testEnv.DB.prepare(
        "INSERT INTO auth_attempt (attempt_key, attempts, last_attempt_at, next_allowed_at, last_attempt_id) VALUES (?, 1, ?, 0, 'x')",
      ).bind(`address:${crypto.randomUUID()}`, old),
    ]);
    await testEnv.DB.batch(purgeStatements(testEnv.DB, Date.now()));
    const left = await testEnv.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM totp_use WHERE used_at = ?1) + (SELECT COUNT(*) FROM auth_attempt WHERE last_attempt_at = ?1) AS count",
    )
      .bind(old)
      .first<{ count: number }>();
    expect(left?.count).toBe(0);
  });
});
