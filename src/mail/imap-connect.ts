import { connect } from "cloudflare:sockets";
import { createSocketsTransport, ImapFlow } from "imapflow";
import { log } from "../log";

export interface ImapCredential {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
}

const socketsTransport = () =>
  createSocketsTransport((address, options) =>
    connect(address, {
      allowHalfOpen: options?.allowHalfOpen ?? false,
      secureTransport: options?.secureTransport ?? "off",
    }),
  );

export const openImap = async (credential: ImapCredential): Promise<ImapFlow> => {
  const client = new ImapFlow({
    host: credential.host,
    port: credential.port,
    secure: credential.secure,
    doSTARTTLS: !credential.secure,
    auth: { user: credential.username, pass: credential.password },
    logger: false,
    transport: socketsTransport(),
  });
  client.on("error", (error: unknown) => {
    log.error("imap connection error", {
      host: credential.host,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
  await client.connect();
  return client;
};
