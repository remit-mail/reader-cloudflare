import { randomBytes } from "node:crypto";
import { cfApi } from "./cf-api.mjs";

export const ensureLoginSecret = async ({ token, accountId, storeId, name, project }) => {
  const path = `/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`;
  const listed = await cfApi(
    token,
    "GET",
    `${path}?search=${encodeURIComponent(name)}&per_page=100`,
  );
  if (listed.some((secret) => secret.name === name)) {
    console.log(`login-secret: ${name} exists; its value stays where it is`);
    return;
  }
  await cfApi(token, "POST", path, [
    {
      name,
      value: randomBytes(32).toString("base64"),
      scopes: ["workers"],
      comment: `better-auth secret of the ${project} login Worker; delete it and deploy to rotate`,
    },
  ]);
  console.log(`login-secret: created ${name}`);
};
