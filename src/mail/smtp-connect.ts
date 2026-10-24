import net from "node:net";
import tls from "node:tls";
import nodemailer, { type Transporter } from "nodemailer";
import type { ImapCredential } from "./imap-connect";
import { allowsPlaintext } from "./plaintext";

export type SmtpCredential = ImapCredential;

export const openSmtp = (credential: SmtpCredential): Transporter => {
  const { host, port, secure } = credential;
  const plaintext = allowsPlaintext(host, secure);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && !plaintext,
    ignoreTLS: plaintext,
    auth: { user: credential.username, pass: credential.password },
    getSocket: (_options, callback) => {
      const connection = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      callback(null, { connection, secured: secure });
    },
  });
};
