import type { ApiRegistry } from "@remit/backend/serve";
import { messageHandlers } from "./messages";

export const localHandlers = {
  ...messageHandlers,
} satisfies ApiRegistry<never>["handlers"];
