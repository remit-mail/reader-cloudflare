import type { ApiRegistry } from "@remit/backend/serve";
import { accountHandlers } from "./accounts";
import { messageHandlers } from "./messages";
import { syncHandlers } from "./sync";

export const localHandlers = {
  ...accountHandlers,
  ...messageHandlers,
  ...syncHandlers,
} satisfies ApiRegistry<never>["handlers"];
