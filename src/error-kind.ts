import { HostRefusedError } from "@remit/data-ports/errors";
import { ZodError } from "zod";

export type ErrorKind =
  | "quota"
  | "validation"
  | "auth"
  | "notFound"
  | "conflict"
  | "notImplemented"
  | "imap"
  | "smtp"
  | "storage"
  | "credential"
  | "interrupted"
  | "client"
  | "unknown";

const CODE_KINDS: Readonly<Record<string, ErrorKind>> = {
  ValidationError: "validation",
  Unauthorized: "auth",
  NotFound: "notFound",
  MethodNotAllowed: "client",
  NotImplemented: "notImplemented",
  OutboxNotSendable: "conflict",
  OutboxNotEditable: "conflict",
  SmtpSendFailed: "smtp",
  ImapFlagPushFailed: "imap",
  CredentialUnavailable: "credential",
  request_refused: "quota",
};

const MESSAGE_KINDS: readonly (readonly [RegExp, ErrorKind])[] = [
  [
    /exceeded allowed|exceeded maximum|exceeded .*limit|quota|too many (?:requests|subrequests)|rate limit|overloaded|concurrent request rate|SQLITE_FULL|disk is full/i,
    "quota",
  ],
  [/smtp/i, "smtp"],
  [/imap|mailbox lock|command failed|authenticationfailed|connection not available/i, "imap"],
  [/D1_|SQLITE|durable object|storage|R2|object .* not found/i, "storage"],
  [/decrypt|credential/i, "credential"],
];

export const errorKindOfCode = (status: number, code: string): ErrorKind => {
  const known = CODE_KINDS[code];
  if (known !== undefined) return known;
  if (status === 409) return "conflict";
  return status < 500 ? "client" : "unknown";
};

export const errorKindOf = (error: unknown): ErrorKind => {
  if (error instanceof ZodError) return "validation";
  if (error instanceof HostRefusedError) return "quota";
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return MESSAGE_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown";
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const quotaRefusal = (reason: string): string =>
  `This account hit a Cloudflare storage or request limit; try again later. ${reason}`;

export const refuseQuota = (error: unknown): never => {
  if (error instanceof HostRefusedError) throw error;
  if (errorKindOf(error) === "quota")
    throw new HostRefusedError(quotaRefusal(messageOf(error)), error);
  throw error;
};
