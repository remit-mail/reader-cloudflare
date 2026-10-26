import net from "node:net";
import tls from "node:tls";
import type { SendMessageContext } from "@remit/smtp-worker/process";
import { allowsPlaintext } from "./plaintext";

export type SmtpGetSocket = SendMessageContext["getSocket"];

export const workersSmtpSocket: SmtpGetSocket = (options, callback) => {
  const { host } = options;
  const port = Number(options.port);
  if (host === undefined || !Number.isInteger(port)) {
    callback(new Error("the SMTP transport named no host or port to connect to"));
    return;
  }
  const secure = options.secure === true;
  const plaintext = allowsPlaintext(host, secure);
  const connection = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  callback(null, {
    connection,
    secured: secure,
    requireTLS: !secure && !plaintext,
    ignoreTLS: plaintext,
  });
};
