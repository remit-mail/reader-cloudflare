import { UpdateAddressInputSchema } from "@remit/api-zod-schemas";
import type { HandlerContext } from "@remit/backend/serve";
import { BadRequestError, NotFoundError } from "@remit/data-ports/errors";
import type { Context } from "openapi-backend";
import { z } from "zod";
import { updateAddressFlags } from "../../mail/operations";
import { toAddressResponse } from "./responses";

const addressParams = z.object({ addressId: z.string().min(1) });

const updateAddress = async (context: Context, ctx: HandlerContext) => {
  const { addressId } = addressParams.parse(context.request.params);
  const input = UpdateAddressInputSchema.parse(context.request.requestBody ?? {});
  const updated = await updateAddressFlags(ctx.client, ctx.identity.accountConfigId, addressId, {
    flags: input.flags ?? {},
    clearFlags: input.clearFlags ?? [],
  });
  if (updated.kind === "NotFound") throw new NotFoundError("Address not found");
  if (updated.kind === "Invalid") {
    throw new BadRequestError(`Invalid address flags: ${updated.reason}`);
  }
  return toAddressResponse(updated.address);
};

export const addressHandlers = {
  AddressDetailOperations_updateAddress: updateAddress,
};
