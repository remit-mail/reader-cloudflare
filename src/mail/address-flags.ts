import type { AddressFlags, SenderTrust } from "@remit/api-openapi-types";
import { AddressFlagsSchema } from "@remit/api-zod-schemas";

const isAddressFlags = (value: unknown): value is AddressFlags =>
  AddressFlagsSchema.strict().safeParse(value).success;

export const storedFlags = (value: unknown, addressId: string): AddressFlags => {
  if (isAddressFlags(value)) return value;
  throw new Error(`address ${addressId} holds flags outside the contract`);
};

export const senderTrustOf = (flags: AddressFlags): SenderTrust => {
  if (flags.vip?.value === true) return "vip";
  if (flags.wellknown?.value === true) return "wellknown";
  return "unknown";
};
