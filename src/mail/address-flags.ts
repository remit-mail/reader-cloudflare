import type { AddressFlagKey, AddressFlags, SenderTrust } from "@remit/api-openapi-types";
import { AddressFlagsSchema } from "@remit/api-zod-schemas";

export interface AddressFlagsPatch {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly clearFlags: readonly AddressFlagKey[];
}

export type MergedFlags =
  | { readonly ok: true; readonly flags: AddressFlags }
  | { readonly ok: false; readonly reason: string };

export const isAddressFlags = (value: unknown): value is AddressFlags =>
  AddressFlagsSchema.strict().safeParse(value).success;

export const storedFlags = (value: unknown, addressId: string): AddressFlags => {
  if (isAddressFlags(value)) return value;
  throw new Error(`address ${addressId} holds flags outside the contract`);
};

export const mergeAddressFlags = (current: AddressFlags, patch: AddressFlagsPatch): MergedFlags => {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch.flags)) {
    if (value === undefined) continue;
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  for (const key of patch.clearFlags) delete next[key];
  if (!isAddressFlags(next)) return { ok: false, reason: "flags do not match the contract" };
  return { ok: true, flags: next };
};

export const senderTrustOf = (flags: AddressFlags): SenderTrust => {
  if (flags.vip?.value === true) return "vip";
  if (flags.wellknown?.value === true) return "wellknown";
  return "unknown";
};

export const isMuted = (flags: AddressFlags): boolean => flags.muted?.value === true;
