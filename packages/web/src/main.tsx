import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider, accessOffline, PEOPLE_URL } from "./access-auth";
import { securitySlot } from "./security-slot";

mountApp({
  authProvider: accessAuthProvider,
  offline: accessOffline,
  peopleDestinationUrl: PEOPLE_URL,
  settingsSlots: [securitySlot],
});
