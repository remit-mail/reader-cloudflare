import { UpdateAddressInputSchema } from "@remit/api-zod-schemas";
import { z } from "zod";
import { tenantMail } from "../../stubs";
import { toAddressResponse } from "../mappers";
import { accountConfigOf, type Handler, mailAccountsOf, parse } from "../request";
import { invalid, notFound, ok } from "../respond";

const addressParams = z.object({ addressId: z.string().min(1) });

const updateAddress: Handler = async (context, request) => {
  const params = parse(addressParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const body = parse(UpdateAddressInputSchema, request.body ?? {}, "address update");
  if (!body.ok) return body.response;
  const accountConfigId = accountConfigOf(await mailAccountsOf(request));
  if (accountConfigId === null) return notFound("Address");
  const updated = await tenantMail(request.env, request.tenant.tenantId).updateAddressFlags(
    accountConfigId,
    params.value.addressId,
    { flags: body.value.flags ?? {}, clearFlags: body.value.clearFlags ?? [] },
  );
  if (updated.kind === "NotFound") return notFound("Address");
  if (updated.kind === "Invalid") return invalid(`Invalid address flags: ${updated.reason}`);
  return ok(toAddressResponse(updated.address));
};

export const addressHandlers = {
  AddressDetailOperations_updateAddress: updateAddress,
} satisfies Record<string, Handler>;
