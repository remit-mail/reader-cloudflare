import { masterKeyBytes } from "../crypto/envelope";
import type { Env } from "../env";

const LABEL = "remit-content-url-signing-v1";
const TTL_SECONDS = 3600;
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;

export interface ContentSignature {
  readonly exp: number;
  readonly sig: string;
}

export type ContentSigner = (relativePath: string) => Promise<ContentSignature>;

export type SignatureCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "missing" | "malformed" | "expired" | "invalid" };

const encoder = new TextEncoder();

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const signingKey = async (env: Env): Promise<CryptoKey> => {
  const master = await crypto.subtle.importKey("raw", await masterKeyBytes(env), HMAC, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", master, encoder.encode(LABEL));
  return crypto.subtle.importKey("raw", derived, HMAC, false, ["sign", "verify"]);
};

const message = (relativePath: string, exp: number): Uint8Array =>
  encoder.encode(`${relativePath}\n${exp}`);

export const createContentSigner = async (env: Env): Promise<ContentSigner> => {
  const key = await signingKey(env);
  return async (relativePath) => {
    const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const sig = await crypto.subtle.sign("HMAC", key, message(relativePath, exp));
    return { exp, sig: toBase64Url(sig) };
  };
};

export const verifyContentSignature = async (
  env: Env,
  relativePath: string,
  expRaw: string | null,
  sigRaw: string | null,
): Promise<SignatureCheck> => {
  if (expRaw === null || sigRaw === null) return { valid: false, reason: "missing" };
  const exp = Number(expRaw);
  const sig = fromBase64Url(sigRaw);
  if (!Number.isInteger(exp) || exp <= 0 || sig === null) {
    return { valid: false, reason: "malformed" };
  }
  if (exp < Math.floor(Date.now() / 1000)) return { valid: false, reason: "expired" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(env),
    sig,
    message(relativePath, exp),
  );
  return valid ? { valid: true } : { valid: false, reason: "invalid" };
};
