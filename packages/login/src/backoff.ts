import { normalizeEmail } from "./config";
import { randomId, sha256Hex } from "./crypto";

const FREE_ATTEMPTS = 5;
const RESET_AFTER_MS = 24 * 60 * 60_000;

interface Curve {
  readonly baseMs: number;
  readonly capMs: number;
}

const ADDRESS_CURVE: Curve = { baseMs: 30_000, capMs: 15 * 60_000 };
const ACCOUNT_CURVE: Curve = { baseMs: 10_000, capMs: 2 * 60_000 };

export interface AttemptKey {
  readonly key: string;
  readonly curve: Curve;
}

export const addressOf = (request: { headers: Headers }): string => {
  const address = request.headers.get("cf-connecting-ip");
  if (address === null) throw new Error("the request carries no cf-connecting-ip header");
  return address;
};

const ipv6Prefix = (address: string, groups: number): string => {
  const [head = "", tail = ""] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const expanded = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${expanded
    .slice(0, groups)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/${groups * 16}`;
};

const addressPrefix = (address: string): string =>
  address.includes(":") ? ipv6Prefix(address, 4) : address;

const resetAddressPrefix = (address: string): string =>
  address.includes(":") ? ipv6Prefix(address, 3) : address;

export const addressKey = (address: string): AttemptKey => ({
  key: `address:${addressPrefix(address)}`,
  curve: ADDRESS_CURVE,
});

export const accountKey = async (email: string): Promise<AttemptKey> => ({
  key: `account:${await sha256Hex(normalizeEmail(email))}`,
  curve: ACCOUNT_CURVE,
});

export const userKey = (userId: string): AttemptKey => ({
  key: `user:${userId}`,
  curve: ADDRESS_CURVE,
});

const RESERVE = `INSERT INTO auth_attempt (attempt_key, attempts, last_attempt_at, next_allowed_at, last_attempt_id)
VALUES (?1, 1, ?2, 0, ?7)
ON CONFLICT (attempt_key) DO UPDATE SET
  attempts = CASE
    WHEN next_allowed_at > ?2 THEN attempts
    WHEN last_attempt_at < ?2 - ?3 THEN 1
    ELSE attempts + 1
  END,
  last_attempt_at = CASE WHEN next_allowed_at > ?2 THEN last_attempt_at ELSE ?2 END,
  last_attempt_id = CASE WHEN next_allowed_at > ?2 THEN last_attempt_id ELSE ?7 END,
  next_allowed_at = CASE
    WHEN next_allowed_at > ?2 THEN next_allowed_at
    WHEN last_attempt_at < ?2 - ?3 THEN 0
    WHEN attempts + 1 <= ?4 THEN 0
    ELSE ?2 + MIN(?6, ?5 * (1 << MIN(attempts + 1 - ?4, 20)))
  END
RETURNING attempt_key, attempts, next_allowed_at, last_attempt_id`;

const RESERVE_BEHIND_GATE = RESERVE.replace(
  "VALUES (?1, 1, ?2, 0, ?7)",
  "SELECT ?1, 1, ?2, 0, ?7 WHERE EXISTS (SELECT 1 FROM auth_attempt WHERE attempt_key = ?8 AND last_attempt_id = ?7)",
);

export type Reservation =
  | { readonly allowed: true; readonly firstDelay: boolean }
  | { readonly allowed: false; readonly retryAt: number };

export const reserveAttempt = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  now: number,
): Promise<Reservation> => {
  const attemptId = randomId();
  const [gate, ...rest] = keys;
  if (gate === undefined) return { allowed: true, firstDelay: false };
  const results = await db.batch<{
    attempt_key: string;
    attempts: number;
    next_allowed_at: number;
    last_attempt_id: string;
  }>([
    db
      .prepare(RESERVE)
      .bind(
        gate.key,
        now,
        RESET_AFTER_MS,
        FREE_ATTEMPTS,
        gate.curve.baseMs,
        gate.curve.capMs,
        attemptId,
      ),
    ...rest.map(({ key, curve }) =>
      db
        .prepare(RESERVE_BEHIND_GATE)
        .bind(
          key,
          now,
          RESET_AFTER_MS,
          FREE_ATTEMPTS,
          curve.baseMs,
          curve.capMs,
          attemptId,
          gate.key,
        ),
    ),
  ]);
  const rows = results.flatMap((result) => result.results);
  const blocked = rows.filter((row) => row.last_attempt_id !== attemptId);
  if (blocked.length > 0) {
    return { allowed: false, retryAt: Math.max(...blocked.map((row) => row.next_allowed_at)) };
  }
  return { allowed: true, firstDelay: rows.some((row) => row.attempts === FREE_ATTEMPTS + 1) };
};

export const clearKey = async (db: D1Database, key: AttemptKey): Promise<void> => {
  await db.prepare("DELETE FROM auth_attempt WHERE attempt_key = ?").bind(key.key).run();
};

export const refundKey = async (db: D1Database, key: AttemptKey): Promise<void> => {
  await db
    .prepare(
      "UPDATE auth_attempt SET attempts = MAX(attempts - 1, 0), next_allowed_at = CASE WHEN attempts - 1 <= ? THEN 0 ELSE next_allowed_at END WHERE attempt_key = ?",
    )
    .bind(FREE_ATTEMPTS, key.key)
    .run();
};

const QUOTA_WINDOW_MS = 15 * 60_000;
const ADDRESS_QUOTA = 5;
const ACCOUNT_QUOTA = 4 * ADDRESS_QUOTA;

const QUOTA_UPSERT = `INSERT INTO auth_attempt (attempt_key, attempts, last_attempt_at, next_allowed_at, last_attempt_id)
VALUES (?1, 1, ?2, 0, ?1)
ON CONFLICT (attempt_key) DO UPDATE SET
  attempts = CASE WHEN last_attempt_at < ?2 - ?3 THEN 1 ELSE attempts + 1 END,
  last_attempt_at = CASE WHEN last_attempt_at < ?2 - ?3 THEN ?2 ELSE last_attempt_at END
RETURNING attempts`;

const takeQuota = async (
  db: D1Database,
  key: string,
  quota: number,
  now: number,
): Promise<boolean> => {
  const row = await db
    .prepare(QUOTA_UPSERT)
    .bind(key, now, QUOTA_WINDOW_MS)
    .first<{ attempts: number }>();
  return row !== null && row.attempts <= quota;
};

export const takeResetQuota = async (
  db: D1Database,
  address: string,
  email: string,
  now: number,
): Promise<boolean> => {
  if (!(await takeQuota(db, `reset:address:${resetAddressPrefix(address)}`, ADDRESS_QUOTA, now))) {
    return false;
  }
  return takeQuota(db, `reset:${(await accountKey(email)).key}`, ACCOUNT_QUOTA, now);
};
