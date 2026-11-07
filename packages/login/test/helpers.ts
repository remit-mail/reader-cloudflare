import { env as baseEnv, waitUntil } from "cloudflare:workers";
import { createOTP } from "@better-auth/utils/otp";
import { hashPassword, makeSignature, symmetricEncrypt } from "better-auth/crypto";
import { vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

export const OPERATOR = "operator@remit.test";
export const OTHER_OPERATOR = "second-operator@remit.test";
export const ORIGIN = "http://localhost:8791";
export const PASSWORD = "correct horse battery staple";
const SECRET = "test-login-auth-secret-of-enough-length-0123456789";

export interface SentMail {
  readonly to: unknown;
  readonly text: string;
}

export const sent: SentMail[] = [];

export const testEnv: Env = {
  ...(baseEnv as Env),
  LOGIN_ORIGIN: ORIGIN,
  OPERATOR_EMAILS: `${OPERATOR},${OTHER_OPERATOR}`,
  LOGIN_AUTH_SECRET: { get: async () => SECRET } as SecretsStoreSecret,
  EMAIL: {
    send: async (message: { to?: unknown; text?: unknown }) => {
      sent.push({ to: message.to, text: String(message.text) });
      return { messageId: `test-${sent.length}` };
    },
  } as unknown as SendEmail,
};

const octet = (): number => Math.floor(Math.random() * 254) + 1;

export const randomAddress = (): string => `10.${octet()}.${octet()}.${octet()}`;

export interface CallInit {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly address?: string;
  readonly headers?: Record<string, string>;
  readonly env?: Env;
}

export const call = (path: string, init: CallInit = {}): Promise<Response> =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: ORIGIN,
        "cf-connecting-ip": init.address ?? randomAddress(),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    init.env ?? testEnv,
  );

export const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

export const TOTP_SECRET = "a-totp-secret-for-tests";

export interface SignedIn {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookie: string;
}

export const auth = () => createAuth(testEnv, waitUntil);

export const uniqueEmail = (label: string): string => `${label}-${crypto.randomUUID()}@remit.test`;

export const createUser = async (
  email: string,
  options: { totp?: boolean; password?: string } = {},
) => {
  const context = await (await auth()).$context;
  const user = await context.internalAdapter.createUser(
    { email, name: email, emailVerified: true },
    { method: "email-password" },
  );
  if (options.password) {
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(options.password),
    });
  }
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

export const addPasskeyRow = async (userId: string, credentialId: string): Promise<void> => {
  await testEnv.DB.prepare(
    "INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) VALUES (?, 'AA==', ?, ?, 0, 'singleDevice', 0)",
  )
    .bind(crypto.randomUUID(), userId, credentialId)
    .run();
};

export const signIn = async (userId: string): Promise<SignedIn> => {
  const context = await (await auth()).$context;
  const session = await context.internalAdapter.createSession(userId);
  const signed = encodeURIComponent(
    `${session.token}.${await makeSignature(session.token, SECRET)}`,
  );
  return { userId, sessionId: session.id, cookie: `better-auth.session_token=${signed}` };
};

export const totpCode = (step: number): Promise<string> => createOTP(TOTP_SECRET).hotp(step);

const sha1Hex = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();

export const mockPwnedPasswords = (pwned: readonly string[] | "unreachable") => {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return original(input, init);
    if (pwned === "unreachable") return new Response("unavailable", { status: 503 });
    const prefix = url.slice(-5);
    const lines = await Promise.all(
      pwned.map(async (password) => {
        const hash = await sha1Hex(password);
        return hash.startsWith(prefix) ? `${hash.slice(5)}:42` : "";
      }),
    );
    return new Response(["0000000000000000000000000000000000A:0", ...lines].join("\r\n"));
  });
};
