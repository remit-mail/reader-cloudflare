import type { ThreadCursor } from "../mail/types";

const TOKEN = /^(-?\d+):([A-Za-z0-9]+)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type CursorResult =
  | { readonly ok: true; readonly cursor: ThreadCursor | null }
  | { readonly ok: false };

export const encodeCursor = (cursor: ThreadCursor): string =>
  btoa(`${cursor.sentDate}:${cursor.messageId}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const decodeCursor = (token: string | undefined): CursorResult => {
  if (token === undefined || token === "") return { ok: true, cursor: null };
  if (!BASE64URL.test(token) || token.length % 4 === 1) return { ok: false };
  const padded = token
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(token.length / 4) * 4, "=");
  const match = TOKEN.exec(atob(padded));
  if (match?.[1] === undefined || match[2] === undefined) return { ok: false };
  return { ok: true, cursor: { sentDate: Number(match[1]), messageId: match[2] } };
};
