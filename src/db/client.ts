import { AsyncLocalStorage } from "node:async_hooks";
import { asyncBatch, type SqliteLimits, type SqliteStore } from "@remit/drizzle-service";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database;

export type AppStore = SqliteStore<Record<string, unknown>>;

const meter = new AsyncLocalStorage<{ queries: number }>();

export const withD1Meter = <T>(run: () => Promise<T>): Promise<T> => meter.run({ queries: 0 }, run);

export const d1Queries = (): number => meter.getStore()?.queries ?? 0;

const tally = (): void => {
  const store = meter.getStore();
  if (store !== undefined) store.queries += 1;
};

const counted = (binding: D1Database): D1Database =>
  new Proxy(binding, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          tally();
          return target.prepare(query);
        };
      }
      if (property === "exec") {
        return (query: string): Promise<D1ExecResult> => {
          tally();
          return target.exec(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const openAppDb = (binding: D1Database): AppDb => drizzle(counted(binding));

export const openAppStore = (
  binding: D1Database,
  { maxBoundParameters }: SqliteLimits,
): AppStore => {
  const db = openAppDb(binding);
  return { db, batch: asyncBatch(db), maxBoundParameters };
};
