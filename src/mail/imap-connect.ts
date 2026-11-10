import { connect } from "cloudflare:sockets";
import type { ConnectionScopeFactory } from "@remit/backend/create-remit-client";
import {
  type ConnectImap,
  type ConnectionPool,
  lifecycleConnectionScope,
} from "@remit/imap-worker/process";
import { logger } from "@remit/logger";
import { connectionScope, type ImapTransport } from "@remit/mailbox-service";
import type { createSocketsTransport } from "imapflow";
import { microsoftTokens } from "../api/config";
import { allowsPlaintext } from "./plaintext";

type SocketsTransport = typeof createSocketsTransport;

export type WorkersTransport = (host: string, secure: boolean) => ImapTransport;

const workersSockets = (sockets: SocketsTransport): ImapTransport =>
  sockets((address, options) =>
    connect(address, {
      allowHalfOpen: options?.allowHalfOpen ?? false,
      secureTransport: options?.secureTransport ?? "off",
    }),
  );

const socketsTransport = (sockets: SocketsTransport): ImapTransport => {
  const transport = workersSockets(sockets);
  const upgrade = transport.upgrade;
  if (upgrade === undefined) throw new Error("the cloudflare:sockets transport cannot start TLS");
  return {
    ...transport,
    upgrade: (socket, { tls: _verifiedByTheRuntime, ...options }, onSecure) =>
      upgrade(socket, options, onSecure),
  };
};

const cleartextTransport = (sockets: SocketsTransport): ImapTransport => {
  const { upgrade: _never, ...transport } = workersSockets(sockets);
  return transport;
};

export const loadWorkersTransport = async (): Promise<WorkersTransport> => {
  const { createSocketsTransport } = await import("imapflow");
  return (host, secure) =>
    allowsPlaintext(host, secure)
      ? cleartextTransport(createSocketsTransport)
      : socketsTransport(createSocketsTransport);
};

export const connectImap =
  (transport: WorkersTransport): ConnectImap =>
  (account, credentials) =>
    connectionScope({
      host: account.imapHost,
      port: account.imapPort,
      tls: account.imapTls,
      user: account.username,
      credentials,
      transport: transport(account.imapHost, account.imapTls),
    });

export const pooledConnectionScope = (pool: ConnectionPool): ConnectionScopeFactory =>
  lifecycleConnectionScope(
    microsoftTokens,
    (account, credentials) => {
      const lease = pool.borrow(account, credentials);
      return {
        getConnection: () =>
          lease.getConnection().catch(async (error: unknown) => {
            await lease.release();
            throw error;
          }),
        disconnect: () => lease.release(),
      };
    },
    logger,
  );
