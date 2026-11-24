import { deriveAccountConfigId } from "@remit/data-ports/id";
import { and, eq, ne, notExists, sql } from "drizzle-orm";
import { openAppDb } from "./db/client";
import {
  calendarFeedTokens,
  mcpDeviceCode,
  mcpOauthAccessToken,
  mcpOauthConsent,
  mcpOauthRefreshToken,
  mcpSession,
  tenantEmails,
  tenantKeys,
} from "./db/schema";
import type { LoginOperatorService } from "./operator-audit-contract";

export const normalizedEmail = (email: string): string => email.trim().toLowerCase();

export const recordTenantEmail = async (
  binding: D1Database,
  tenantId: string,
  email: string,
): Promise<void> => {
  const normalized = normalizedEmail(email);
  const db = openAppDb(binding);
  const unenrolled = notExists(
    db.select({ one: sql`1` }).from(tenantEmails).where(eq(tenantEmails.tenantId, tenantId)),
  );
  await db.batch([
    db
      .delete(calendarFeedTokens)
      .where(
        and(eq(calendarFeedTokens.accountConfigId, deriveAccountConfigId(tenantId)), unenrolled),
      ),
    ...[mcpOauthAccessToken, mcpOauthRefreshToken, mcpSession, mcpOauthConsent, mcpDeviceCode].map(
      (table) => db.delete(table).where(and(eq(table.userId, tenantId), unenrolled)),
    ),
    db
      .delete(tenantEmails)
      .where(and(eq(tenantEmails.email, normalized), ne(tenantEmails.tenantId, tenantId))),
    db
      .insert(tenantEmails)
      .values({ tenantId, email: normalized })
      .onConflictDoUpdate({
        target: tenantEmails.tenantId,
        set: { email: normalized },
        setWhere: sql`${tenantEmails.email} <> excluded.email`,
      }),
  ]);
};

export const emailOfTenant = async (
  binding: D1Database,
  tenantId: string,
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .select({ email: tenantEmails.email })
    .from(tenantEmails)
    .where(eq(tenantEmails.tenantId, tenantId));
  return row?.email;
};

export const tenantOfEmail = async (
  binding: D1Database,
  email: string,
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .select({ tenantId: tenantEmails.tenantId })
    .from(tenantEmails)
    .where(eq(tenantEmails.email, normalizedEmail(email)));
  return row?.tenantId;
};

export const mailTenantOfEmail = async (
  binding: D1Database,
  email: string,
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .selectDistinct({ tenantId: tenantEmails.tenantId })
    .from(tenantEmails)
    .innerJoin(tenantKeys, eq(tenantKeys.tenantId, tenantEmails.tenantId))
    .where(eq(tenantEmails.email, normalizedEmail(email)));
  return row?.tenantId;
};

export const mailTenantEmails = async (binding: D1Database): Promise<readonly string[]> => {
  const rows = await openAppDb(binding)
    .selectDistinct({ email: tenantEmails.email })
    .from(tenantEmails)
    .innerJoin(tenantKeys, eq(tenantKeys.tenantId, tenantEmails.tenantId));
  return rows.map((row) => row.email);
};

export const isTenantDisabled = async (
  binding: D1Database,
  login: Pick<LoginOperatorService, "isDisabled">,
  tenantId: string,
): Promise<boolean> => {
  const email = await emailOfTenant(binding, tenantId);
  return email === undefined || (await login.isDisabled(email));
};

export const isTenantOperator = async (
  binding: D1Database,
  login: Pick<LoginOperatorService, "isOperator">,
  tenantId: string,
): Promise<boolean> => {
  const email = await emailOfTenant(binding, tenantId);
  return email !== undefined && (await login.isOperator(email));
};
