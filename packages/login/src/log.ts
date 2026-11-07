type Level = "info" | "warn" | "error";

const ALLOWED_FIELDS = [
  "event",
  "outcome",
  "route",
  "status",
  "durationMs",
  "action",
  "reason",
  "errorKind",
  "count",
] as const;

type Field = (typeof ALLOWED_FIELDS)[number];

export type LogFields = Partial<Record<Field, string | number | boolean>>;

const write = (level: Level, message: string, fields: LogFields): void => {
  const allowed = Object.fromEntries(
    ALLOWED_FIELDS.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]]),
  );
  console[level](JSON.stringify({ level, message, time: new Date().toISOString(), ...allowed }));
};

export const log = {
  info: (message: string, fields: LogFields = {}): void => write("info", message, fields),
  warn: (message: string, fields: LogFields = {}): void => write("warn", message, fields),
  error: (message: string, fields: LogFields = {}): void => write("error", message, fields),
};
