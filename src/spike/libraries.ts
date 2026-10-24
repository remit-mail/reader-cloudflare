import { connect } from "cloudflare:sockets";
import net from "node:net";
import tls from "node:tls";
import { createSocketsTransport, ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer from "nodemailer";

const bogusAuth = { user: "tls-spike@example.invalid", pass: "not-a-password" };

const isAuthenticationFailure = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "authenticationFailed" in error &&
  error.authenticationFailed === true;

const imapHandshake = async (options: ImapFlowOptions): Promise<void> => {
  const client = new ImapFlow({ ...options, auth: bogusAuth, logger: false });
  client.on("error", () => {});
  const outcome = await client.connect().then(
    () => undefined,
    (error: unknown) => error,
  );
  client.close();
  if (outcome === undefined || isAuthenticationFailure(outcome)) return;
  throw outcome;
};

export const imapflowImplicit = (): Promise<void> =>
  imapHandshake({ host: "imap.gmail.com", port: 993, secure: true });

export const imapflowStarttls = (): Promise<void> =>
  imapHandshake({ host: "imap.gmx.com", port: 143, secure: false, doSTARTTLS: true });

export const imapflowStarttlsSockets = (): Promise<void> =>
  imapHandshake({
    host: "imap.gmx.com",
    port: 143,
    secure: false,
    doSTARTTLS: true,
    transport: createSocketsTransport((address, options) =>
      connect(address, {
        allowHalfOpen: options?.allowHalfOpen ?? false,
        secureTransport: options?.secureTransport ?? "off",
      }),
    ),
  });

const smtpVerify = async (options: {
  port: number;
  secure: boolean;
  requireTLS: boolean;
}): Promise<void> => {
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", ...options });
  await transport.verify();
  transport.close();
};

export const nodemailerImplicit = (): Promise<void> =>
  smtpVerify({ port: 465, secure: true, requireTLS: false });

export const nodemailerStarttls = (): Promise<void> =>
  smtpVerify({ port: 587, secure: false, requireTLS: true });

const viaRuntimeDns = async (options: {
  port: number;
  secure: boolean;
  requireTLS: boolean;
}): Promise<void> => {
  const host = "smtp.gmail.com";
  const transport = nodemailer.createTransport({
    host,
    ...options,
    getSocket: (_options, callback) => {
      const connection = options.secure
        ? tls.connect({ host, port: options.port, servername: host })
        : net.connect({ host, port: options.port });
      callback(null, { connection, secured: options.secure });
    },
  });
  await transport.verify();
  transport.close();
};

export const nodemailerImplicitSocket = (): Promise<void> =>
  viaRuntimeDns({ port: 465, secure: true, requireTLS: false });

export const nodemailerStarttlsSocket = (): Promise<void> =>
  viaRuntimeDns({ port: 587, secure: false, requireTLS: true });
