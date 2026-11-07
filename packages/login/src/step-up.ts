import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import type { adminChallenges } from "login-db-schema";
import type { LoginConfig } from "./config";
import { randomId, randomToken } from "./crypto";
import { currentTotpStep, recordTotpStep, totpMatchesStep } from "./totp";
import { isAssertion, ownPasskeyOptions, passkeyCount, verifyOwnPasskey } from "./webauthn";

type ChallengeRow = typeof adminChallenges.$inferSelect;

export type AdminAction = ChallengeRow["action"];
export type StepUpMethod = ChallengeRow["method"];

export const ADMIN_ACTIONS: readonly AdminAction[] = [
  "Invite",
  "Disable",
  "Enable",
  "ResetFactors",
  "SignOutEverywhere",
  "RotateKeys",
  "RevokeKeys",
];

export const KEY_ACTIONS: ReadonlySet<AdminAction> = new Set(["RotateKeys", "RevokeKeys"]);

export const isAdminAction = (value: unknown): value is AdminAction =>
  typeof value === "string" && (ADMIN_ACTIONS as readonly string[]).includes(value);

const CHALLENGE_LIFE_MS = 2 * 60_000;

export interface Binding {
  readonly operatorUserId: string;
  readonly sessionId: string;
  readonly action: AdminAction;
  readonly targetEmail: string;
}

export interface Operator {
  readonly userId: string;
  readonly email: string;
  readonly totpSecret: string | null;
  readonly passkeys: number;
}

export const stepUpMethodOf = (operator: Operator): StepUpMethod | null => {
  if (operator.passkeys > 0) return "Passkey";
  if (operator.totpSecret !== null) return "Totp";
  return null;
};

export const loadOperatorFactors = async (
  db: D1Database,
  userId: string,
  email: string,
): Promise<Operator> => {
  const twoFactor = await db
    .prepare(
      "SELECT two_factor.secret AS secret FROM two_factor JOIN user ON user.id = two_factor.user_id WHERE two_factor.user_id = ? AND user.two_factor_enabled = 1",
    )
    .bind(userId)
    .first<{ secret: string }>();
  return {
    userId,
    email,
    totpSecret: twoFactor?.secret ?? null,
    passkeys: await passkeyCount(db, userId),
  };
};

export type OpenedChallenge =
  | {
      readonly adminChallengeId: string;
      readonly method: "Passkey";
      readonly options: PublicKeyCredentialRequestOptionsJSON;
    }
  | { readonly adminChallengeId: string; readonly method: "Totp" };

export const openChallenge = async (
  db: D1Database,
  config: LoginConfig,
  operator: Operator,
  binding: Binding,
  now: number,
): Promise<OpenedChallenge | null> => {
  const method = stepUpMethodOf(operator);
  if (method === null) return null;
  const adminChallengeId = randomId();
  const challenge = randomToken();
  await db.batch([
    db
      .prepare(
        "UPDATE admin_challenge SET state = 'Expired' WHERE operator_user_id = ? AND state = 'Open'",
      )
      .bind(binding.operatorUserId),
    db
      .prepare(
        "INSERT INTO admin_challenge (admin_challenge_id, operator_user_id, session_id, action, target_email, challenge, method, state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?)",
      )
      .bind(
        adminChallengeId,
        binding.operatorUserId,
        binding.sessionId,
        binding.action,
        binding.targetEmail,
        challenge,
        method,
        now + CHALLENGE_LIFE_MS,
      ),
  ]);
  if (method === "Totp") return { adminChallengeId, method };
  return {
    adminChallengeId,
    method,
    options: await ownPasskeyOptions(db, config, operator.userId, challenge),
  };
};

export const consumeChallenge = (
  db: D1Database,
  adminChallengeId: string,
  binding: Binding,
  now: number,
): Promise<{ challenge: string; method: StepUpMethod } | null> =>
  db
    .prepare(
      "UPDATE admin_challenge SET state = 'Used' WHERE admin_challenge_id = ? AND operator_user_id = ? AND session_id = ? AND action = ? AND target_email = ? AND state = 'Open' AND expires_at > ? RETURNING challenge, method",
    )
    .bind(
      adminChallengeId,
      binding.operatorUserId,
      binding.sessionId,
      binding.action,
      binding.targetEmail,
      now,
    )
    .first<{ challenge: string; method: StepUpMethod }>();

export type Proof =
  | { readonly kind: "Passkey"; readonly assertion: unknown }
  | { readonly kind: "Totp"; readonly code: string };

type SecretKey = Parameters<typeof totpMatchesStep>[0];

export const verifyProof = async (
  db: D1Database,
  config: LoginConfig,
  secretKey: SecretKey,
  operator: Operator,
  consumed: { challenge: string; method: StepUpMethod },
  adminChallengeId: string,
  proof: Proof,
  now: number,
): Promise<boolean> => {
  if (consumed.method !== proof.kind) return false;
  if (proof.kind === "Passkey") {
    if (!isAssertion(proof.assertion)) return false;
    return verifyOwnPasskey(db, config, operator.userId, proof.assertion, consumed.challenge);
  }
  if (operator.totpSecret === null) return false;
  const step = currentTotpStep(now);
  if (!(await totpMatchesStep(secretKey, operator.totpSecret, proof.code, step))) return false;
  return recordTotpStep(db, operator.userId, step, adminChallengeId, now);
};
