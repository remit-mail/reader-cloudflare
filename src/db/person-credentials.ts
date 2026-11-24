import { deriveAccountConfigId } from "@remit/data-ports/id";
import { and, eq, type SQL } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  calendarFeedTokens,
  mcpDeviceCode,
  mcpOauthAccessToken,
  mcpOauthConsent,
  mcpOauthRefreshToken,
  mcpSession,
} from "./schema";

export const personCredentialDeletes = (
  db: AppDb,
  tenantId: string,
  { disabled }: { disabled: boolean },
  where?: SQL,
) =>
  [
    db.delete(mcpOauthAccessToken).where(and(eq(mcpOauthAccessToken.userId, tenantId), where)),
    db.delete(mcpOauthRefreshToken).where(and(eq(mcpOauthRefreshToken.userId, tenantId), where)),
    db.delete(mcpSession).where(and(eq(mcpSession.userId, tenantId), where)),
    ...(disabled
      ? [
          db.delete(mcpOauthConsent).where(and(eq(mcpOauthConsent.userId, tenantId), where)),
          db.delete(mcpDeviceCode).where(and(eq(mcpDeviceCode.userId, tenantId), where)),
          db
            .delete(calendarFeedTokens)
            .where(
              and(eq(calendarFeedTokens.accountConfigId, deriveAccountConfigId(tenantId)), where),
            ),
        ]
      : []),
  ] as const;
