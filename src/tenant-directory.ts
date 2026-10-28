import { eq } from "drizzle-orm";
import { openAppDb } from "./db/client";
import { calendarFeedTokens, tenantAccountConfigs } from "./db/schema";

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
): Promise<string | undefined> => {
  const [row] = await openAppDb(binding)
    .select({ tenantId: tenantAccountConfigs.tenantId })
    .from(calendarFeedTokens)
    .innerJoin(
      tenantAccountConfigs,
      eq(calendarFeedTokens.accountConfigId, tenantAccountConfigs.accountConfigId),
    )
    .where(eq(calendarFeedTokens.tokenHash, tokenHash))
    .limit(1);
  return row?.tenantId;
};
