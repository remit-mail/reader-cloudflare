import { randomBytes } from "node:crypto";
import { cfApi } from "./cf-api.mjs";

export const ensureStoreSecret = async ({ token, accountId, storeId, name, comment }) => {
  const path = `/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`;
  const listed = await cfApi(
    token,
    "GET",
    `${path}?search=${encodeURIComponent(name)}&per_page=100`,
  );
  if (listed.some((secret) => secret.name === name)) {
    console.log(`store-secret: ${name} exists; its value stays where it is`);
    return;
  }
  await cfApi(token, "POST", path, [
    {
      name,
      value: randomBytes(32).toString("base64"),
      scopes: ["workers"],
      comment,
    },
  ]);
  console.log(`store-secret: created ${name}`);
};
