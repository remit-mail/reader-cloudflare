import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ConnectImap,
  type ConnectionPool,
  type ConnectionPoolOptions,
  createConnectionPool,
} from "@remit/imap-worker/process";

export interface PoolMeter {
  waitedMs: number;
}

const meters = new AsyncLocalStorage<PoolMeter>();

export const metered = <T>(meter: PoolMeter, run: () => Promise<T>): Promise<T> =>
  meters.run(meter, run);

export const meteredPool = (
  options: ConnectionPoolOptions,
  connect: ConnectImap,
): ConnectionPool => {
  const grantedAt = new Map<string, number>();
  const granting: ConnectImap = (account, credentials) => {
    const scope = connect(account, credentials);
    return {
      getConnection: () => {
        grantedAt.set(account.accountId, Date.now());
        return scope.getConnection();
      },
      disconnect: () => scope.disconnect(),
    };
  };
  const pool = createConnectionPool(options, granting);
  return {
    borrow: (account, credentials) => {
      const borrowed = pool.borrow(account, credentials);
      return {
        getConnection: async () => {
          const askedAt = Date.now();
          const connection = await borrowed.getConnection();
          const granted = grantedAt.get(account.accountId);
          if (granted === undefined) {
            throw new Error(`the pool lent ${account.accountId} a connection it never granted`);
          }
          const meter = meters.getStore();
          if (meter !== undefined) meter.waitedMs += granted - askedAt;
          return connection;
        },
        release: () => borrowed.release(),
      };
    },
  };
};
