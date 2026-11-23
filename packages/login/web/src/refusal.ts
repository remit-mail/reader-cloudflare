export interface Refusal {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
  readonly code: string;
  readonly retryAt: number | null;
}

export type Failure =
  | { readonly kind: "locked"; readonly message: string; readonly retryAt: number | null }
  | { readonly kind: "server"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export const SIGN_IN_LINK_EXPIRED = "invalid_signature";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const retryText = (retryAt: unknown): string =>
  typeof retryAt === "string" ? ` Try again after ${new Date(retryAt).toLocaleTimeString()}.` : "";

export const refusalOf = (status: number, body: unknown): Refusal => {
  const record = isRecord(body) ? body : {};
  const message =
    stringOf(record.message) ||
    stringOf(record.error_description) ||
    stringOf(body) ||
    (record.error === SIGN_IN_LINK_EXPIRED
      ? "The authorization request could not be verified."
      : "") ||
    `The login site refused the request (HTTP ${status}) without saying why.`;
  return {
    ok: false,
    status,
    message: `${sentence(message)}${status === 429 ? retryText(record.retryAt) : ""}`,
    code: stringOf(record.code) || stringOf(record.error),
    retryAt: typeof record.retryAt === "string" ? Date.parse(record.retryAt) || null : null,
  };
};

export const failureOf = (answer: Refusal): Failure => {
  if (answer.status === 429) {
    return { kind: "locked", message: answer.message, retryAt: answer.retryAt };
  }
  if (answer.status === 0 || answer.status >= 500) {
    return { kind: "server", message: answer.message };
  }
  return { kind: "refused", message: answer.message };
};
