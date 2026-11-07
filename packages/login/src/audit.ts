import type { auditEvents } from "login-db-schema";
import { randomId } from "./crypto";

type AuditRow = typeof auditEvents.$inferSelect;

export type AuditKind = AuditRow["event"];
export type AuditOutcome = AuditRow["outcome"];

export interface AuditEntry {
  readonly actor: string;
  readonly email: string;
  readonly address: string;
  readonly event: AuditKind;
  readonly outcome: AuditOutcome;
  readonly clientId?: string;
}

const RETENTION_MS = 90 * 24 * 60 * 60_000;

export const auditStatement = (
  db: D1Database,
  entry: AuditEntry,
  at: number,
): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO audit_event (audit_event_id, at, actor, email, address, event, outcome, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      randomId(),
      at,
      entry.actor,
      entry.email.toLowerCase(),
      entry.address,
      entry.event,
      entry.outcome,
      entry.clientId ?? "none",
    );

export const audit = async (db: D1Database, entry: AuditEntry): Promise<void> => {
  await auditStatement(db, entry, Date.now()).run();
};

export const auditRows = async (db: D1Database, days: number): Promise<readonly AuditRow[]> => {
  const since = Date.now() - days * 24 * 60 * 60_000;
  const rows = await db
    .prepare(
      "SELECT audit_event_id, at, actor, email, address, event, outcome, client_id FROM audit_event WHERE at >= ? ORDER BY at DESC LIMIT 1000",
    )
    .bind(since)
    .all<{
      audit_event_id: string;
      at: number;
      actor: string;
      email: string;
      address: string;
      event: AuditKind;
      outcome: AuditOutcome;
      client_id: string;
    }>();
  return rows.results.map((row) => ({
    auditEventId: row.audit_event_id,
    at: row.at,
    actor: row.actor,
    email: row.email,
    address: row.address,
    event: row.event,
    outcome: row.outcome,
    clientId: row.client_id,
  }));
};

const DAY_MS = 24 * 60 * 60_000;

export const purgeStatements = (db: D1Database, now: number): D1PreparedStatement[] => [
  db.prepare("DELETE FROM audit_event WHERE at < ?").bind(now - RETENTION_MS),
  db.prepare("DELETE FROM totp_use WHERE used_at < ?").bind(now - DAY_MS),
  db.prepare("DELETE FROM invite WHERE expires_at < ?").bind(now),
  db.prepare("DELETE FROM onboarding_grant WHERE expires_at < ?").bind(now),
  db.prepare("DELETE FROM admin_challenge WHERE expires_at < ?").bind(now),
  db.prepare("DELETE FROM auth_attempt WHERE last_attempt_at < ?").bind(now - DAY_MS),
  db.prepare("DELETE FROM verification WHERE expires_at < ?").bind(now),
];
