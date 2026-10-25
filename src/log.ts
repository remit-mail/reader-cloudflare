import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const context = new AsyncLocalStorage<Fields>();

export const withLogContext = <T>(fields: Fields, run: () => T): T =>
  context.run({ ...fields }, run);

export const annotateLog = (fields: Fields): void => {
  const store = context.getStore();
  if (store !== undefined) Object.assign(store, fields);
};

const write = (level: Level, message: string, fields: Fields): void => {
  console[level](
    JSON.stringify({
      level,
      message,
      time: new Date().toISOString(),
      ...context.getStore(),
      ...fields,
    }),
  );
};

export const log = {
  debug: (message: string, fields: Fields = {}): void => write("debug", message, fields),
  info: (message: string, fields: Fields = {}): void => write("info", message, fields),
  warn: (message: string, fields: Fields = {}): void => write("warn", message, fields),
  error: (message: string, fields: Fields = {}): void => write("error", message, fields),
};

export const currentCorrelationId = (): string => {
  const correlationId = context.getStore()?.correlationId;
  return typeof correlationId === "string" ? correlationId : crypto.randomUUID();
};
