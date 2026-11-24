import { and, eq, isNotNull, or } from "drizzle-orm";
import { openAppDb } from "./db/client";
import { calendarFeedTokens, tenantAccountConfigs, tenantEmails } from "./db/schema";

export const tenantOfAccountConfig = async (
  binding: D1Database,
  accountConfigId: string,
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .select({ tenantId: tenantAccountConfigs.tenantId })
    .from(tenantAccountConfigs)
    .where(eq(tenantAccountConfigs.accountConfigId, accountConfigId));
  return row?.tenantId;
};

export const tenantOfFeedToken = async (
  binding: D1Database,
  tokenHash: string,
  agentTenant: string | undefined,
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .select({ tenantId: tenantAccountConfigs.tenantId })
    .from(calendarFeedTokens)
    .innerJoin(
      tenantAccountConfigs,
      eq(calendarFeedTokens.accountConfigId, tenantAccountConfigs.accountConfigId),
    )
    .leftJoin(tenantEmails, eq(tenantEmails.tenantId, tenantAccountConfigs.tenantId))
    .where(
      and(
        eq(calendarFeedTokens.tokenHash, tokenHash),
        or(
          isNotNull(tenantEmails.tenantId),
          agentTenant === undefined ? undefined : eq(tenantAccountConfigs.tenantId, agentTenant),
        ),
      ),
    )
    .limit(1);
  return row?.tenantId;
};
