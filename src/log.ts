import { AsyncLocalStorage } from "node:async_hooks";
import {
  type LogBindings,
  type Logger,
  logContext,
  normalizeLogArguments,
  setLogger,
} from "@remit/logger";

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

const remitLogger = (bindings: Fields): Logger => {
  let own: Fields = { ...bindings };
  const at =
    (level: Level) =>
    (first: LogBindings | string, second?: LogBindings | string): void => {
      const [fields, message] = normalizeLogArguments(first, second);
      write(level, message, { ...own, ...logContext(), ...fields });
    };
  return {
    trace: at("debug"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("error"),
    child: (more) => remitLogger({ ...own, ...more }),
    setBindings: (more) => {
      own = { ...own, ...more };
    },
  };
};

export const installRemitLogger = (): void => setLogger(remitLogger({}));

interface QueueConsumeBase {
  readonly family: string;
  readonly type: string;
  readonly attempt: number;
  readonly durationMs: number;
}

interface QueueFailure {
  readonly errorKind: string;
  readonly error: string;
}

export type ConsumeReport =
  | { readonly outcome: "Acked"; readonly poolWaitMs: number }
  | ({ readonly outcome: "Retried"; readonly poolWaitMs: number } & QueueFailure);

export type QueueConsume =
  | (QueueConsumeBase & ConsumeReport)
  | (QueueConsumeBase & { readonly outcome: "Unreachable" } & QueueFailure);

export const logQueueConsume = (record: QueueConsume): void => {
  if (record.outcome === "Acked") {
    log.info("queue message consumed", { event: "queue.consume", ...record });
    return;
  }
  log.error("queue message failed", { event: "queue.consume", ...record });
};

export type QueueDeadLetter =
  | {
      readonly id: string;
      readonly attempt: number;
      readonly family: string;
      readonly type: string;
      readonly tenantId: string;
      readonly correlationId: string;
    }
  | {
      readonly id: string;
      readonly attempt: number;
      readonly type: "Unreadable";
      readonly reason: string;
      readonly body: unknown;
    };

export const logQueueDeadLetter = (record: QueueDeadLetter): void =>
  log.error("queue message dead-lettered", { event: "queue.dlq", ...record });
