import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { sameHash } from "./crypto";

type SecretKey = Parameters<typeof symmetricDecrypt>[0]["key"];

const BASE32_PREFIX = "base32:";
const PERIOD_MS = 30_000;

export const currentTotpStep = (now: number): number => Math.floor(now / PERIOD_MS);

const decryptSecret = async (key: SecretKey, data: string): Promise<string | Uint8Array> => {
  const secret = await symmetricDecrypt({ key, data });
  if (!secret.startsWith(BASE32_PREFIX)) return secret;
  return base32.decode(secret.slice(BASE32_PREFIX.length).toUpperCase());
};

export const totpMatchesStep = async (
  key: SecretKey,
  encryptedSecret: string,
  code: string,
  step: number,
): Promise<boolean> => {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = await decryptSecret(key, encryptedSecret);
  const expected = await createOTP(secret).hotp(step);
  return sameHash(expected, code);
};

export const totpStepMatchingNow = async (
  key: SecretKey,
  encryptedSecret: string,
  code: string,
  now: number,
): Promise<number | null> => {
  const step = currentTotpStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (await totpMatchesStep(key, encryptedSecret, code, candidate)) return candidate;
  }
  return null;
};

export const recordTotpStep = async (
  db: D1Database,
  userId: string,
  step: number,
  usedFor: string,
  now: number,
): Promise<boolean> => {
  const recorded = await db
    .prepare(
      "INSERT OR IGNORE INTO totp_use (user_id, totp_step, used_for, used_at) VALUES (?, ?, ?, ?) RETURNING totp_step",
    )
    .bind(userId, step, usedFor, now)
    .first();
  return recorded !== null;
};
