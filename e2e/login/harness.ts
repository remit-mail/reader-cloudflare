import { createHash, createHmac, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { stripVTControlCharacters } from "node:util";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; run \`npm run e2e:login\``);
  return value;
};

export const BASE_URL = required("E2E_LOGIN_BASE_URL");
export const CLIENT_ID = required("E2E_LOGIN_CLIENT_ID");
export const CLIENT_SECRET = required("E2E_LOGIN_CLIENT_SECRET");
export const REDIRECT_URI = required("E2E_LOGIN_REDIRECT_URI");
const CALLBACK_PORT = Number(required("E2E_LOGIN_CALLBACK_PORT"));
const WRANGLER_LOG = required("E2E_LOGIN_WRANGLER_LOG");

export const serveCallback = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("callback");
    });
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => resolve(server));
  });

export const sentMails = (): string[] => {
  const log = stripVTControlCharacters(readFileSync(WRANGLER_LOG, "utf8"));
  return [...log.matchAll(/Text: (\S+\.txt)/g)]
    .map((match) => match[1] ?? "")
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"));
};

export const waitForMail = async (seen: number, pattern: RegExp): Promise<RegExpMatchArray> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const text of sentMails().slice(seen)) {
      const match = text.match(pattern);
      if (match !== null) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no email after the first ${seen} matched ${pattern}`);
};

export interface Authorization {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

export const authorization = (): Authorization => {
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return { url: `${BASE_URL}/api/auth/oauth2/authorize?${query}`, state, nonce, verifier };
};

export interface Tokens {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export const exchange = async (code: string, verifier: string): Promise<Tokens> => {
  const response = await fetch(`${BASE_URL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: verifier,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const decodePart = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export const verifiedClaims = async (idToken: string): Promise<Record<string, unknown>> => {
  const [header, payload, signature] = idToken.split(".");
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error("the id token is not a JWS");
  }
  const { kid, alg } = decodePart(header);
  if (alg !== "RS256") throw new Error(`the id token is signed with ${String(alg)}`);
  const jwks = (await (await fetch(`${BASE_URL}/api/auth/jwks`)).json()) as {
    keys: { kid?: string }[];
  };
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (jwk === undefined) throw new Error(`the jwks has no key ${String(kid)}`);
  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"));
  if (!valid) throw new Error("the id token signature does not verify against the jwks");
  return decodePart(payload);
};

export const userinfo = async (accessToken: string): Promise<Tokens> => {
  const response = await fetch(`${BASE_URL}/api/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_MS = 30_000;

const base32Decode = (encoded: string): Buffer => {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replaceAll("=", "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

const hotp = (key: Buffer, counter: number): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
};

export class Authenticator {
  readonly #key: Buffer;
  #lastStep = 0;

  constructor(base32Secret: string) {
    this.#key = base32Decode(base32Secret);
  }

  async code(): Promise<string> {
    while (this.#lastStep + 1 > Math.floor(Date.now() / PERIOD_MS) + 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const step = Math.max(Math.floor(Date.now() / PERIOD_MS), this.#lastStep + 1);
    this.#lastStep = step;
    return hotp(this.#key, step);
  }
}
