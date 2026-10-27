import { CF_ENV, CF_USER_ENV, PROJECT, readEnvFile } from "./env.mjs";

const API = "https://api.cloudflare.com/client/v4";
const WORKER = PROJECT;

const [command, buildArg] = process.argv.slice(2);
if (command !== "list" && command !== "log") {
  console.error("usage: npm run builds | npm run builds:log -- [build-id]");
  process.exit(2);
}

const account = readEnvFile(CF_ENV).CLOUDFLARE_ACCOUNT_ID;
const token = readEnvFile(CF_USER_ENV).CLOUDFLARE_USER_TOKEN;
if (!account) {
  console.error(`${CF_ENV} does not set CLOUDFLARE_ACCOUNT_ID`);
  process.exit(1);
}
if (!token) {
  console.error(
    `${CF_USER_ENV} does not set CLOUDFLARE_USER_TOKEN; the Builds API refuses account tokens, so it needs a user-owned token with Workers CI Read`,
  );
  process.exit(1);
}

const get = async (path) => {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await response.json().catch(() => ({ success: false, errors: [] }));
  if (response.ok && json.success) return json;
  const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
  console.error(`GET ${path} returned ${response.status}: ${errors}`);
  process.exit(1);
};

const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi;
const BEARER = /\b(Bearer\s+)\S+/gi;
const TOKEN_LIKE = /[A-Za-z0-9_\-+/]{32,}={0,2}/g;
const GIT_SHA = /^[0-9a-f]{40}$/;

const redact = (line) =>
  line
    .replaceAll(token, "[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(BEARER, "$1[redacted]")
    .replace(TOKEN_LIKE, (match) => (GIT_SHA.test(match) ? match : "[redacted]"));

const scripts = (await get(`/accounts/${account}/workers/scripts`)).result;
const script = scripts.find((entry) => entry.id === WORKER);
if (!script) {
  console.error(`no Worker named ${WORKER} in account ${account}`);
  process.exit(1);
}

const builds = async (perPage) =>
  (await get(`/accounts/${account}/builds/workers/${script.tag}/builds?page=1&per_page=${perPage}`))
    .result;

const summary = (build) => ({
  id: build.build_uuid,
  status: build.build_outcome ? `${build.status}/${build.build_outcome}` : build.status,
  branch: build.build_trigger_metadata?.branch,
  sha: build.build_trigger_metadata?.commit_hash?.slice(0, 7),
  created: build.created_on,
});

if (command === "list") {
  console.table((await builds(10)).map(summary));
  process.exit(0);
}

const latestFailedOnMain = async () => {
  const failed = (await builds(50)).find(
    (build) =>
      build.build_trigger_metadata?.branch === "main" &&
      build.status === "stopped" &&
      build.build_outcome !== "success" &&
      build.build_outcome !== "cancelled",
  );
  if (!failed) {
    console.error("no failed build on main among the last 50");
    process.exit(1);
  }
  console.error(JSON.stringify(summary(failed)));
  return failed.build_uuid;
};

const buildId = buildArg ?? (await latestFailedOnMain());
let cursor = "";
do {
  const query = cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const { result } = await get(`/accounts/${account}/builds/builds/${buildId}/logs${query}`);
  for (const [, line] of result.lines ?? []) console.log(redact(String(line)));
  cursor = result.truncated ? (result.cursor ?? "") : "";
} while (cursor !== "");
