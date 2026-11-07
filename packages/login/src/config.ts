import type { Env } from "./env";

export interface LoginConfig {
  readonly loginOrigin: string;
  readonly loginHostname: string;
  readonly readerOrigin: string;
  readonly clientId: string;
  readonly sender: string;
  readonly operatorEmails: ReadonlySet<string>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const configOf = (env: Env): LoginConfig => ({
  loginOrigin: env.LOGIN_ORIGIN,
  loginHostname: new URL(env.LOGIN_ORIGIN).hostname,
  readerOrigin: env.READER_ORIGIN,
  clientId: env.LOGIN_OIDC_CLIENT_ID,
  sender: env.EMAIL_SENDER,
  operatorEmails: new Set(
    env.OPERATOR_EMAILS.split(",")
      .map(normalizeEmail)
      .filter((email) => email.length > 0),
  ),
});

export const isOperator = (config: LoginConfig, email: string): boolean =>
  config.operatorEmails.has(normalizeEmail(email));
