import { normalizeEmail } from "./config";
import { sha256Hex } from "./crypto";

const FREE_FAILURES = 5;
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

export const addressOf = (request: { headers: Headers }): string =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

const addressPrefix = (address: string): string => {
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

export const addressKey = (address: string): AttemptKey => ({
  key: `address:${addressPrefix(address)}`,
  curve: ADDRESS_CURVE,
});

export const accountKey = async (email: string): Promise<AttemptKey> => ({
  key: `account:${await sha256Hex(normalizeEmail(email))}`,
  curve: ACCOUNT_CURVE,
});

export const delayMs = (failures: number, curve: Curve): number => {
  if (failures <= FREE_FAILURES) return 0;
  return Math.min(curve.capMs, curve.baseMs * 2 ** Math.min(failures - FREE_FAILURES, 20));
};

export const retryAt = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  now: number,
): Promise<number | null> => {
  if (keys.length === 0) return null;
  const rows = await db
    .prepare(
      `SELECT next_allowed_at FROM auth_attempt WHERE attempt_key IN (${keys.map(() => "?").join(",")}) AND next_allowed_at > ? AND last_failure_at > ?`,
    )
    .bind(...keys.map(({ key }) => key), now, now - RESET_AFTER_MS)
    .all<{ next_allowed_at: number }>();
  const latest = Math.max(0, ...rows.results.map((row) => row.next_allowed_at));
  return latest > now ? latest : null;
};

const UPSERT = `INSERT INTO auth_attempt (attempt_key, failures, last_failure_at, next_allowed_at)
VALUES (?1, 1, ?2, 0)
ON CONFLICT (attempt_key) DO UPDATE SET
  failures = CASE WHEN last_failure_at < ?2 - ?3 THEN 1 ELSE failures + 1 END,
  last_failure_at = ?2,
  next_allowed_at = CASE
    WHEN (CASE WHEN last_failure_at < ?2 - ?3 THEN 1 ELSE failures + 1 END) <= ?4 THEN 0
    ELSE ?2 + MIN(?6, ?5 * (1 << MIN((CASE WHEN last_failure_at < ?2 - ?3 THEN 1 ELSE failures + 1 END) - ?4, 20)))
  END
RETURNING attempt_key, failures, next_allowed_at`;

export interface FailureOutcome {
  readonly key: string;
  readonly failures: number;
  readonly nextAllowedAt: number;
}

export const recordFailure = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  now: number,
): Promise<readonly FailureOutcome[]> => {
  const results = await db.batch<{
    attempt_key: string;
    failures: number;
    next_allowed_at: number;
  }>(
    keys.map(({ key, curve }) =>
      db.prepare(UPSERT).bind(key, now, RESET_AFTER_MS, FREE_FAILURES, curve.baseMs, curve.capMs),
    ),
  );
  return results.flatMap((result) =>
    result.results.map((row) => ({
      key: row.attempt_key,
      failures: row.failures,
      nextAllowedAt: row.next_allowed_at,
    })),
  );
};

export const firstDelay = (outcomes: readonly FailureOutcome[]): boolean =>
  outcomes.some((outcome) => outcome.failures === FREE_FAILURES + 1);

export const clearKey = async (db: D1Database, key: AttemptKey): Promise<void> => {
  await db.prepare("DELETE FROM auth_attempt WHERE attempt_key = ?").bind(key.key).run();
};

const QUOTA_WINDOW_MS = 15 * 60_000;
const QUOTA = 5;

export const takeResetQuota = async (
  db: D1Database,
  address: string,
  email: string,
  now: number,
): Promise<boolean> => {
  const keys = [`reset:${addressKey(address).key}`, `reset:${(await accountKey(email)).key}`];
  const results = await db.batch<{ failures: number }>(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO auth_attempt (attempt_key, failures, last_failure_at, next_allowed_at)
VALUES (?1, 1, ?2, 0)
ON CONFLICT (attempt_key) DO UPDATE SET
  failures = CASE WHEN last_failure_at < ?2 - ?3 THEN 1 ELSE failures + 1 END,
  last_failure_at = CASE WHEN last_failure_at < ?2 - ?3 THEN ?2 ELSE last_failure_at END
RETURNING failures`,
        )
        .bind(key, now, QUOTA_WINDOW_MS),
    ),
  );
  return results.every((result) => (result.results[0]?.failures ?? 0) <= QUOTA);
};
