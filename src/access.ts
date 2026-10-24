import type { Env } from "./env";

export interface Tenant {
  readonly tenantId: string;
  readonly email: string;
}

export type TenantResult =
  | { readonly ok: true; readonly tenant: Tenant }
  | { readonly ok: false; readonly reason: string };

interface RsaJwk {
  readonly kid: string;
  readonly kty: "RSA";
  readonly n: string;
  readonly e: string;
}

interface JwtHeader {
  readonly alg: string;
  readonly kid: string;
}

interface AccessClaims {
  readonly sub: string;
  readonly email: string;
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
}

interface KeySet {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly expiresAt: number;
}

const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const HEADER = "cf-access-jwt-assertion";
const COOKIE = "CF_Authorization";

const keySets = new Map<string, KeySet>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRsaJwk = (value: unknown): value is RsaJwk =>
  isRecord(value) &&
  value.kty === "RSA" &&
  typeof value.kid === "string" &&
  typeof value.n === "string" &&
  typeof value.e === "string";

const isJwtHeader = (value: unknown): value is JwtHeader =>
  isRecord(value) && typeof value.alg === "string" && typeof value.kid === "string";

const isAudience = (value: unknown): value is string | readonly string[] =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

const isAccessClaims = (value: unknown): value is AccessClaims =>
  isRecord(value) &&
  typeof value.sub === "string" &&
  value.sub !== "" &&
  typeof value.email === "string" &&
  typeof value.iss === "string" &&
  isAudience(value.aud) &&
  typeof value.exp === "number" &&
  (value.nbf === undefined || typeof value.nbf === "number");

const base64UrlDecode = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const parseJson = (bytes: Uint8Array | undefined): unknown => {
  if (bytes === undefined) return undefined;
  const text = decoder.decode(bytes);
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const bearerToken = (request: Request): string | undefined => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
};

const readToken = (request: Request): string | undefined => {
  const header = request.headers.get(HEADER);
  if (header) return header;
  const bearer = bearerToken(request);
  if (bearer !== undefined) return bearer;
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
};

const fetchKeySet = async (teamDomain: string): Promise<KeySet> => {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access JWKS fetch failed with ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("Access JWKS has no keys");
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys.filter(isRsaJwk)) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  const keySet = { keys, expiresAt: Date.now() + JWKS_TTL_MS };
  keySets.set(teamDomain, keySet);
  return keySet;
};

const findKey = async (teamDomain: string, kid: string): Promise<CryptoKey | undefined> => {
  const cached = keySets.get(teamDomain);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    const key = cached.keys.get(kid);
    if (key !== undefined) return key;
  }
  const fresh = await fetchKeySet(teamDomain);
  return fresh.keys.get(kid);
};

const denied = (reason: string): TenantResult => ({ ok: false, reason });

export const requireTenant = async (request: Request, env: Env): Promise<TenantResult> => {
  const token = readToken(request);
  if (token === undefined) return denied("missing Access token");
  const parts = token.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedClaims === undefined ||
    encodedSignature === undefined
  ) {
    return denied("malformed Access token");
  }
  const header = parseJson(base64UrlDecode(encodedHeader));
  if (!isJwtHeader(header) || header.alg !== "RS256") return denied("unsupported Access token");
  const signature = base64UrlDecode(encodedSignature);
  if (signature === undefined) return denied("malformed Access token");
  const key = await findKey(env.ACCESS_TEAM_DOMAIN, header.kid);
  if (key === undefined) return denied("unknown Access signing key");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    encoder.encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) return denied("invalid Access token signature");
  const claims = parseJson(base64UrlDecode(encodedClaims));
  if (!isAccessClaims(claims)) return denied("malformed Access token claims");
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return denied("wrong Access issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!audiences.includes(env.ACCESS_AUD)) return denied("wrong Access audience");
  const now = Date.now() / 1000;
  if (claims.exp + CLOCK_SKEW_S < now) return denied("expired Access token");
  if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_S > now) {
    return denied("Access token not yet valid");
  }
  return { ok: true, tenant: { tenantId: claims.sub, email: claims.email } };
};
