import { base64 } from "@better-auth/utils/base64";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { LoginConfig } from "./config";

interface PasskeyRow {
  readonly id: string;
  readonly credential_id: string;
  readonly public_key: string;
  readonly counter: number;
  readonly transports: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isAssertion = (value: unknown): value is AuthenticationResponseJSON =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.rawId === "string" &&
  value.type === "public-key" &&
  isRecord(value.response) &&
  typeof value.response.clientDataJSON === "string" &&
  typeof value.response.authenticatorData === "string" &&
  typeof value.response.signature === "string";

const passkeysOf = async (db: D1Database, userId: string): Promise<readonly PasskeyRow[]> => {
  const rows = await db
    .prepare(
      "SELECT id, credential_id, public_key, counter, transports FROM passkey WHERE user_id = ?",
    )
    .bind(userId)
    .all<PasskeyRow>();
  return rows.results;
};

export const passkeyCount = async (db: D1Database, userId: string): Promise<number> =>
  (await passkeysOf(db, userId)).length;

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const ownPasskeyOptions = async (
  db: D1Database,
  config: LoginConfig,
  userId: string,
  challenge: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> =>
  generateAuthenticationOptions({
    rpID: config.loginHostname,
    challenge: fromBase64Url(challenge),
    userVerification: "required",
    timeout: 120_000,
    allowCredentials: (await passkeysOf(db, userId)).map((row) => ({
      id: row.credential_id,
      ...(row.transports
        ? { transports: row.transports.split(",") as AuthenticatorTransportFuture[] }
        : {}),
    })),
  });

type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export const verifyOwnPasskey = async (
  db: D1Database,
  config: LoginConfig,
  userId: string,
  assertion: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<boolean> => {
  const row = (await passkeysOf(db, userId)).find(
    (candidate) => candidate.credential_id === assertion.id,
  );
  if (row === undefined) return false;
  const verification = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge,
    expectedOrigin: config.loginOrigin,
    expectedRPID: config.loginHostname,
    requireUserVerification: true,
    credential: {
      id: row.credential_id,
      publicKey: base64.decode(row.public_key),
      counter: row.counter,
      ...(row.transports
        ? { transports: row.transports.split(",") as AuthenticatorTransportFuture[] }
        : {}),
    },
  }).catch(() => null);
  if (!verification?.verified) return false;
  await db
    .prepare("UPDATE passkey SET counter = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, row.id)
    .run();
  return true;
};
