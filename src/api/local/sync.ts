import type { SyncTriggerResponse } from "@remit/api-openapi-types";
import type { HandlerContext } from "@remit/backend/serve";
import type { Context } from "openapi-backend";
import { accountParams, ownedAccount, startSync } from "./accounts";

const triggerSync = async (context: Context, ctx: HandlerContext) => {
  const { accountId } = accountParams.parse(context.request.params);
  const start = await startSync(ctx, await ownedAccount(ctx, accountId));
  const body: SyncTriggerResponse = {
    triggered: start.started,
    message: start.started ? "Sync started" : "Sync already running",
  };
  return body;
};

export const syncHandlers = {
  SyncOperations_triggerSync: triggerSync,
};
