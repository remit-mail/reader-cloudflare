import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider } from "./access-auth";
import { securitySlot } from "./security-slot";

mountApp({ authProvider: accessAuthProvider, settingsSlots: [securitySlot] });
