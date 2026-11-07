import type { LoginConfig } from "./config";

export type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

const send = (email: SendEmail, config: LoginConfig, mail: Mail): Promise<SendOutcome> =>
  email.send({ from: { name: "remit", email: config.sender }, ...mail }).then(
    (): SendOutcome => ({ ok: true }),
    (error: unknown): SendOutcome => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );

export const sendInvite = (
  email: SendEmail,
  config: LoginConfig,
  to: string,
  token: string,
): Promise<SendOutcome> =>
  send(email, config, {
    to,
    subject: "You are invited to remit",
    text: [
      "You have been invited to remit.",
      "",
      `Open this link to choose a password: ${config.loginOrigin}/invite#${token}`,
      "",
      "The link works once and expires in 7 days. If you did not expect it, ignore this message.",
    ].join("\n"),
  });

export const sendResetCode = (
  email: SendEmail,
  config: LoginConfig,
  to: string,
  code: string,
): Promise<SendOutcome> =>
  send(email, config, {
    to,
    subject: "Your remit reset code",
    text: [
      `Your code to reset your remit password is ${code}.`,
      "",
      "It works once and expires in 10 minutes. If you did not ask for it, ignore this message; your password stays as it is.",
    ].join("\n"),
  });

export const sendSecurityChange = (
  email: SendEmail,
  config: LoginConfig,
  to: string,
  change: string,
): Promise<SendOutcome> =>
  send(email, config, {
    to,
    subject: "Your remit sign-in settings changed",
    text: [
      `${change} on your remit account.`,
      "",
      "If this was not you, reset your password from the sign-in page and tell the person who invited you.",
    ].join("\n"),
  });
