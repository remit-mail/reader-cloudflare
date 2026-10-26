import type { ApiRegistry } from "@remit/backend/serve";
import { accountHandlers } from "./accounts";
import { messageHandlers } from "./messages";
import { outboxHandlers } from "./outbox";
import { syncHandlers } from "./sync";

export const localHandlers = {
  ...accountHandlers,
  ...messageHandlers,
  ...outboxHandlers,
  ...syncHandlers,
} satisfies ApiRegistry<never>["handlers"];
