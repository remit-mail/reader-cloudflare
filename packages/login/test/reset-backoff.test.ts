import { afterEach, describe, expect, it, vi } from "vitest";
import { issueResetLink } from "../src/routes/reset";
import {
  call,
  createUser,
  mockPwnedPasswords,
  PASSWORD,
  randomAddress,
  testEnv,
  uniqueEmail,
} from "./helpers";

const FRESH = "a long and fresh password for the reset";

const signInAs = (email: string, password: string, address: string) =>
  call("/api/auth/sign-in/email", { body: { email, password }, address });

const lookup = (token: string, address: string = randomAddress()) =>
  call("/app/reset/lookup", { body: { token }, address });

const redeem = (token: string, address: string = randomAddress(), password = FRESH) =>
  call("/app/reset/password", { body: { token, password }, address });

const lockOut = async (address: string): Promise<void> => {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await signInAs(uniqueEmail("spray"), "wrong password!!", address);
  }
  expect((await signInAs(uniqueEmail("spray"), "wrong password!!", address)).status).toBe(429);
};

const linkFor = async (label: string): Promise<{ email: string; token: string }> => {
  const email = uniqueEmail(label);
  const user = await createUser(email, { password: PASSWORD });
  return { email, token: await issueResetLink(testEnv.DB, user, Date.now()) };
};

describe("reset backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a reset link and takes the new password from an address locked out of sign-in", async () => {
    mockPwnedPasswords([]);
    const address = randomAddress();
    await lockOut(address);
    const { email, token } = await linkFor("locked-out");
    expect((await lookup(token, address)).status).toBe(200);
    expect((await redeem(token, address)).status).toBe(200);
    expect((await signInAs(email, FRESH, randomAddress())).status).toBe(200);
  });

  it("keeps the sign-in lockout of an address after a reset from it", async () => {
    mockPwnedPasswords([]);
    const address = randomAddress();
    await lockOut(address);
    const { email, token } = await linkFor("still-locked");
    expect((await redeem(token, address)).status).toBe(200);
    expect((await signInAs(email, FRESH, address)).status).toBe(429);
  });

  it("slows one address scanning for links without using up a link it then finds", async () => {
    mockPwnedPasswords([]);
    const address = randomAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await lookup(crypto.randomUUID(), address)).status);
    }
    expect(statuses).toEqual([410, 410, 410, 410, 410, 410, 429]);
    const { token } = await linkFor("scanned");
    expect((await lookup(token, address)).status).toBe(429);
    expect((await redeem(token, address)).status).toBe(429);
    expect((await lookup(token)).status).toBe(200);
    expect((await redeem(token)).status).toBe(200);
  });

  it("refuses the lookup up front once the link itself is paused", async () => {
    mockPwnedPasswords([]);
    const { token } = await linkFor("paused");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await redeem(token, randomAddress(), "too short")).status).toBe(400);
    }
    const refused = await lookup(token);
    expect(refused.status).toBe(429);
    expect((await refused.json()) as { retryAt: string }).toHaveProperty("retryAt");
    expect((await redeem(token)).status).toBe(429);
  });
});
