import { connect } from "cloudflare:sockets";
import type { ConnectionScopeFactory } from "@remit/backend/create-remit-client";
import type { ConnectImap, ConnectionPool } from "@remit/imap-worker/process";
import { connectionScope, type ImapTransport } from "@remit/mailbox-service";
import { createSocketsTransport } from "imapflow";
import { accountPassword } from "../crypto/envelope";
import { allowsPlaintext } from "./plaintext";

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

export const connectImap: ConnectImap = (account, credentials) =>
  connectionScope({
    host: account.imapHost,
    port: account.imapPort,
    tls: account.imapTls,
    user: account.username,
    credentials,
    transport: workersTransport(account.imapHost, account.imapTls),
  });

export const pooledConnectionScope =
  (pool: ConnectionPool): ConnectionScopeFactory =>
  (accounts, secrets) =>
  async (accountId) => {
    const account = await accounts.get(accountId);
    const lease = pool.borrow(account, {
      kind: "password",
      password: await accountPassword(secrets, account),
    });
    return {
      getConnection: () =>
        lease.getConnection().catch(async (error: unknown) => {
          await lease.release();
          throw error;
        }),
      disconnect: () => lease.release(),
    };
  };
