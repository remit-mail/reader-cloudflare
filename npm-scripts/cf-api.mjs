import { createHash } from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";

export const cfApi = async (token, method, path) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({ success: false, errors: [] }));
  if (response.ok && json.success) return json.result;
  const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
  throw new Error(`${method} ${path} returned ${response.status}: ${errors}`);
};

export const resolveAccountId = async (token) => {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await cfApi(token, "GET", "/accounts");
  if (accounts.length !== 1) {
    console.error(`the token sees ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
    process.exit(1);
  }
  return accounts[0].id;
};

export const r2Credentials = async (token, accountId) => {
  const { id } = await cfApi(token, "GET", `/accounts/${accountId}/tokens/verify`);
  return { accessKeyId: id, secretAccessKey: createHash("sha256").update(token).digest("hex") };
};
