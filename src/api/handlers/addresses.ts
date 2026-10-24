import { UpdateAddressInputSchema } from "@remit/api-zod-schemas";
import { z } from "zod";
import { tenantMail } from "../../stubs";
import { toAddressResponse } from "../mappers";
import { accountsOf, type Handler, parse } from "../request";
import { invalid, notFound, ok } from "../respond";

const addressParams = z.object({ addressId: z.string().min(1) });

const updateAddress: Handler = async (context, request) => {
  const params = parse(addressParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const body = parse(UpdateAddressInputSchema, request.body ?? {}, "address update");
  if (!body.ok) return body.response;
  const accountConfigIds = [
    ...new Set((await accountsOf(request)).map((account) => account.accountConfigId)),
  ];
  const updated = await tenantMail(request.env, request.tenant.tenantId).updateAddressFlags(
    params.value.addressId,
    accountConfigIds,
    { flags: body.value.flags ?? {}, clearFlags: body.value.clearFlags ?? [] },
  );
  if (updated.kind === "NotFound") return notFound("Address");
  if (updated.kind === "Invalid") return invalid(`Invalid address flags: ${updated.reason}`);
  return ok(toAddressResponse(updated.address));
};

export const addressHandlers = {
  AddressDetailOperations_updateAddress: updateAddress,
} satisfies Record<string, Handler>;
