import { ButtonLink } from "@remit/ui";
import type { SettingsSlot } from "@remit/web-client/shell";
import { ShieldCheck } from "lucide-react";
import { SECURITY_URL } from "./access-auth";

const SecuritySettings = () => (
  <ButtonLink href={SECURITY_URL}>Manage two-factor authentication and passkeys</ButtonLink>
);

export const securitySlot: SettingsSlot = {
  id: "security",
  label: "Security",
  icon: <ShieldCheck aria-hidden />,
  Component: SecuritySettings,
  help: (
    <>
      Two-factor authentication asks for a code from an authenticator app after your password, so a
      stolen password alone cannot sign in. A passkey signs you in with your device's fingerprint,
      face or screen lock instead of a password.
    </>
  ),
};
