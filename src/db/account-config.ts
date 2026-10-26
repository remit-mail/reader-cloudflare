import { base36uuidv5, deriveAccountConfigId, REMIT_NAMESPACE } from "@remit/data-ports/id";
import { eq } from "drizzle-orm";
import { openAppDb } from "./client";
import { accountConfigs } from "./schema";

const resolved = new Map<string, string>();

// Tenants admitted before reader's derived ids keep the random account config the
// prototype created, found by the user id it stored for them.
const prototypeUserId = (tenantId: string): string =>
  base36uuidv5(`user:${tenantId}`, REMIT_NAMESPACE);

export const accountConfigIdOf = async (binding: D1Database, tenantId: string): Promise<string> => {
  const known = resolved.get(tenantId);
  if (known !== undefined) return known;
  const [prototype] = await openAppDb(binding)
    .select({ accountConfigId: accountConfigs.accountConfigId })
    .from(accountConfigs)
    .where(eq(accountConfigs.userId, prototypeUserId(tenantId)))
    .limit(1);
  const accountConfigId = prototype?.accountConfigId ?? deriveAccountConfigId(tenantId);
  resolved.set(tenantId, accountConfigId);
  return accountConfigId;
};
