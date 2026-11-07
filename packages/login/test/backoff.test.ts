import { describe, expect, it } from "vitest";
import { accountKey } from "../src/backoff";
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
});
