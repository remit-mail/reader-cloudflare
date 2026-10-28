import { connect } from "cloudflare:sockets";
import type { ConnectionScopeFactory } from "@remit/backend/create-remit-client";
import type { ConnectImap, ConnectionPool } from "@remit/imap-worker/process";
import { connectionScope, type ImapTransport } from "@remit/mailbox-service";
import { resolveConnectionCredentials } from "@remit/mailbox-service/account-credentials";
import { createSocketsTransport } from "imapflow";
import { microsoftTokens } from "./microsoft-tokens";
import { allowsPlaintext, mailEndpoint } from "./plaintext";

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

export const connectImap: ConnectImap = (account, credentials) => {
  const { host, port, tls } = mailEndpoint({
    host: account.imapHost,
    port: account.imapPort,
    tls: account.imapTls,
  });
  return connectionScope({
    host,
    port,
    tls,
    user: account.username,
    credentials,
    transport: workersTransport(host, tls),
  });
};

export const pooledConnectionScope =
  (pool: ConnectionPool): ConnectionScopeFactory =>
  (accounts, secrets) =>
  async (accountId) => {
    const account = await accounts.get(accountId);
    const resolution = await resolveConnectionCredentials(account, {
      secrets,
      tokenService: microsoftTokens,
      persistRotatedToken: async (rotatedAccountId, oauthRefreshTokenHash, oauthTokenUpdatedAt) => {
        await accounts.update(rotatedAccountId, { oauthRefreshTokenHash, oauthTokenUpdatedAt });
      },
    });
    if (resolution.status === "missing") {
      throw new Error(`account ${accountId} stores no credential: ${resolution.reason}`);
    }
    const lease = pool.borrow(account, resolution.credentials);
    return {
      getConnection: () =>
        lease.getConnection().catch(async (error: unknown) => {
          await lease.release();
          throw error;
        }),
      disconnect: () => lease.release(),
    };
  };
