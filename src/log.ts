type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const write = (level: Level, message: string, fields: Fields): void => {
  console[level](JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));
};

export const log = {
  debug: (message: string, fields: Fields = {}): void => write("debug", message, fields),
  info: (message: string, fields: Fields = {}): void => write("info", message, fields),
  warn: (message: string, fields: Fields = {}): void => write("warn", message, fields),
  error: (message: string, fields: Fields = {}): void => write("error", message, fields),
};
