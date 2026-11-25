import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider, PEOPLE_URL, SESSION_URL } from "./access-auth";
import { securitySlot } from "./security-slot";

mountApp({
  authProvider: accessAuthProvider,
  offline: { sessionUrl: SESSION_URL, reauthenticate: accessAuthProvider.reauthenticate },
  peopleDestinationUrl: PEOPLE_URL,
  settingsSlots: [securitySlot],
});
