import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider, accessOffline } from "./access-auth";
import { securitySlot } from "./security-slot";

mountApp({
  authProvider: accessAuthProvider,
  offline: accessOffline,
  settingsSlots: [securitySlot],
});
