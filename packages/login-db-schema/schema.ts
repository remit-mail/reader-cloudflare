import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const invites = sqliteTable(
  "invite",
  {
    inviteId: text("invite_id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    state: text("state").$type<"Open" | "Redeemed" | "Replaced" | "Revoked">().notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    stateChangedAt: integer("state_changed_at", { mode: "number" }).notNull(),
    issuedBy: text("issued_by").notNull(),
  },
  (table) => [
    index("invite_email").on(table.email),
    uniqueIndex("invite_token_hash").on(table.tokenHash),
  ],
);

export const onboardingGrants = sqliteTable(
  "onboarding_grant",
  {
    onboardingGrantId: text("onboarding_grant_id").primaryKey(),
    inviteId: text("invite_id").notNull(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("onboarding_grant_token_hash").on(table.tokenHash)],
);

export const resetLinks = sqliteTable(
  "reset_link",
  {
    resetLinkId: text("reset_link_id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    state: text("state").$type<"Open" | "Used" | "Replaced">().notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    stateChangedAt: integer("state_changed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("reset_link_user").on(table.userId),
    uniqueIndex("reset_link_token_hash").on(table.tokenHash),
  ],
);

export const authAttempts = sqliteTable("auth_attempt", {
  attemptKey: text("attempt_key").primaryKey(),
  attempts: integer("attempts").notNull(),
  lastAttemptAt: integer("last_attempt_at", { mode: "number" }).notNull(),
  nextAllowedAt: integer("next_allowed_at", { mode: "number" }).notNull(),
  lastAttemptId: text("last_attempt_id").notNull(),
});

export const adminChallenges = sqliteTable(
  "admin_challenge",
  {
    adminChallengeId: text("admin_challenge_id").primaryKey(),
    operatorUserId: text("operator_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    action: text("action")
      .$type<
        | "Invite"
        | "Disable"
        | "Enable"
        | "ResetFactors"
        | "SignOutEverywhere"
        | "RotateKeys"
        | "RevokeKeys"
      >()
      .notNull(),
    targetEmail: text("target_email").notNull(),
    challenge: text("challenge").notNull(),
    method: text("method").$type<"Passkey" | "Totp">().notNull(),
    state: text("state").$type<"Open" | "Used" | "Expired">().notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("admin_challenge_one_open").on(table.operatorUserId).where(sql`state = 'Open'`),
    index("admin_challenge_operator").on(table.operatorUserId),
  ],
);

export const totpUses = sqliteTable(
  "totp_use",
  {
    userId: text("user_id").notNull(),
    totpStep: integer("totp_step", { mode: "number" }).notNull(),
    usedFor: text("used_for").notNull(),
    usedAt: integer("used_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ name: "totp_use_pk", columns: [table.userId, table.totpStep] })],
);

export const auditEvents = sqliteTable(
  "audit_event",
  {
    auditEventId: text("audit_event_id").primaryKey(),
    at: integer("at", { mode: "number" }).notNull(),
    actor: text("actor").notNull(),
    email: text("email").notNull(),
    address: text("address").notNull(),
    event: text("event")
      .$type<
        | "InviteIssued"
        | "InviteRedeemed"
        | "SignIn"
        | "SecondStepRequired"
        | "Backoff"
        | "ResetRequested"
        | "PasswordReset"
        | "FreshLinkRequested"
        | "PasswordChanged"
        | "FactorAdded"
        | "FactorRemoved"
        | "FactorRenamed"
        | "BackupCodesRegenerated"
        | "SignOut"
        | "SignOutEverywhere"
        | "TokenIssued"
        | "AdminStepUp"
        | "FactorReset"
        | "Disabled"
        | "Enabled"
        | "KeysRotated"
        | "KeysRevoked"
      >()
      .notNull(),
    outcome: text("outcome").$type<"Succeeded" | "Refused">().notNull(),
    clientId: text("client_id").notNull(),
  },
  (table) => [index("audit_event_at").on(table.at)],
);

export const capturedMails = sqliteTable(
  "captured_mail",
  {
    capturedMailId: text("captured_mail_id").primaryKey(),
    capturedAt: integer("captured_at", { mode: "number" }).notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
  },
  (table) => [index("captured_mail_captured_at").on(table.capturedAt)],
);
