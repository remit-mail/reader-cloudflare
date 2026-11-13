import { CF_ENV, PROJECT, readEnvFile } from "./env.mjs";

const API = "https://api.cloudflare.com/client/v4";
const BRANCH = "main";

const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = readEnvFile(CF_ENV);
if (!account || !token) {
  console.error(`${CF_ENV} must set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN`);
  process.exit(1);
}

const call = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.ok) return JSON.parse(text).result;
  console.error(`${method} ${path} returned ${response.status}: ${text}`);
  process.exit(1);
};

const script = (await call("GET", `/accounts/${account}/workers/scripts`)).find(
  (entry) => entry.id === PROJECT,
);
if (!script) {
  console.error(`no Worker named ${PROJECT} in the account`);
  process.exit(1);
}

const trigger = (
  await call("GET", `/accounts/${account}/builds/workers/${script.tag}/triggers`)
).find((entry) => (entry.branch_includes ?? []).includes(BRANCH));
if (!trigger) {
  console.error(`no Workers Builds trigger on ${BRANCH} for ${PROJECT}`);
  process.exit(1);
}

const build = await call(
  "POST",
  `/accounts/${account}/builds/triggers/${trigger.trigger_uuid}/builds`,
  { branch: BRANCH },
);
console.log(
  JSON.stringify({
    id: build.build_uuid,
    sha: build.build_trigger_metadata?.commit_hash,
    status: build.status,
  }),
);
