import { connect } from "cloudflare:sockets";
import type { ConnectionScopeFactory } from "@remit/backend/create-remit-client";
import { connectionScope, type ImapTransport } from "@remit/mailbox-service";
import { createSocketsTransport, ImapFlow } from "imapflow";
import { accountPassword } from "../crypto/envelope";
import { log } from "../log";
import { allowsPlaintext } from "./plaintext";

export interface ImapCredential {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
}

const workersSockets = (): ImapTransport =>
  createSocketsTransport((address, options) =>
    connect(address, {
      allowHalfOpen: options?.allowHalfOpen ?? false,
      secureTransport: options?.secureTransport ?? "off",
    }),
  );

const socketsTransport = (): ImapTransport => {
  const sockets = workersSockets();
  const upgrade = sockets.upgrade;
  if (upgrade === undefined) throw new Error("the cloudflare:sockets transport cannot start TLS");
  return {
    ...sockets,
    upgrade: (socket, { tls: _verifiedByTheRuntime, ...options }, onSecure) =>
      upgrade(socket, options, onSecure),
  };
};

const cleartextTransport = (): ImapTransport => {
  const { upgrade: _never, ...sockets } = workersSockets();
  return sockets;
};

export const workersTransport = (host: string, secure: boolean): ImapTransport =>
  allowsPlaintext(host, secure) ? cleartextTransport() : socketsTransport();

export const workersConnectionScope: ConnectionScopeFactory =
  (accounts, secrets) => async (accountId) => {
    const account = await accounts.get(accountId);
    return connectionScope({
      host: account.imapHost,
      port: account.imapPort,
      tls: account.imapTls,
      user: account.username,
      credentials: { kind: "password", password: await accountPassword(secrets, account) },
      transport: workersTransport(account.imapHost, account.imapTls),
    });
  };

export const openImap = async (credential: ImapCredential): Promise<ImapFlow> => {
  const client = new ImapFlow({
    host: credential.host,
    port: credential.port,
    secure: credential.secure,
    doSTARTTLS: !credential.secure && !allowsPlaintext(credential.host, credential.secure),
    auth: { user: credential.username, pass: credential.password },
    logger: false,
    transport: workersTransport(credential.host, credential.secure),
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
