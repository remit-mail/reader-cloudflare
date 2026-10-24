import net from "node:net";
import tls from "node:tls";
import nodemailer, { type Transporter } from "nodemailer";
import type { ImapCredential } from "./imap-connect";

export type SmtpCredential = ImapCredential;

export const openSmtp = (credential: SmtpCredential): Transporter => {
  const { host, port, secure } = credential;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: credential.username, pass: credential.password },
    getSocket: (_options, callback) => {
      const connection = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      callback(null, { connection, secured: secure });
    },
  });
};
