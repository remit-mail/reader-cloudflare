import { env as baseEnv, waitUntil } from "cloudflare:workers";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

export const OPERATOR = "operator@remit.test";
export const OTHER_OPERATOR = "second-operator@remit.test";
export const ORIGIN = "http://localhost:8791";
const SECRET = "test-login-auth-secret-of-enough-length-0123456789";

export interface SentMail {
  readonly to: unknown;
  readonly text: unknown;
}

export const sent: SentMail[] = [];

export const testEnv: Env = {
  ...(baseEnv as Env),
  LOGIN_ORIGIN: ORIGIN,
  OPERATOR_EMAILS: `${OPERATOR},${OTHER_OPERATOR}`,
  LOGIN_AUTH_SECRET: { get: async () => SECRET } as SecretsStoreSecret,
  EMAIL: {
    send: async (message: { to?: unknown; text?: unknown }) => {
      sent.push({ to: message.to, text: message.text });
      return { messageId: `test-${sent.length}` };
    },
  } as unknown as SendEmail,
};

export const call = (
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: ORIGIN,
        "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    testEnv,
  );

const sign = async (value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...signature))}`);
};

export const TOTP_SECRET = "a-totp-secret-for-tests";

export interface SignedIn {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookie: string;
}

export const auth = () => createAuth(testEnv, waitUntil);

export const createUser = async (email: string, options: { totp?: boolean } = {}) => {
  const context = await (await auth()).$context;
  const user = await context.internalAdapter.createUser(
    { email, name: email, emailVerified: true },
    { method: "email-password" },
  );
  if (options.totp) {
    await testEnv.DB.prepare(
      "INSERT INTO two_factor (id, secret, backup_codes, user_id, verified) VALUES (?, ?, ?, ?, 1)",
    )
      .bind(
        crypto.randomUUID(),
        await symmetricEncrypt({ key: context.secretConfig, data: TOTP_SECRET }),
        "",
        user.id,
      )
      .run();
    await testEnv.DB.prepare("UPDATE user SET two_factor_enabled = 1 WHERE id = ?")
      .bind(user.id)
      .run();
  }
  return user;
};

export const signIn = async (userId: string): Promise<SignedIn> => {
  const context = await (await auth()).$context;
  const session = await context.internalAdapter.createSession(userId);
  return {
    userId,
    sessionId: session.id,
    cookie: `better-auth.session_token=${await sign(session.token)}`,
  };
};

export const totpCode = (step: number): Promise<string> => createOTP(TOTP_SECRET).hotp(step);
