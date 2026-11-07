import { cfApi } from "./cf-api.mjs";

const SCOPES = {
  account: "com.cloudflare.api.account",
  zone: "com.cloudflare.api.account.zone",
};
const TOKENS_WRITE = "Account API Tokens Write";

export const RUNNER_GROUPS = [
  { name: "Access: Organizations, Identity Providers, and Groups Write", scope: "account" },
  { name: "Email Sending Write", scope: "zone" },
];

const fail = (message) => {
  console.error(`runner-grant: ${message}`);
  process.exit(1);
};

export const grantRunner = async (token, accountId, zoneName) => {
  const api = (method, path, body) => cfApi(token, method, path, body);

  const accountBase = `/accounts/${accountId}/tokens`;
  const accountVerify = await api("GET", `${accountBase}/verify`).catch(() => undefined);
  const base = accountVerify ? accountBase : "/user/tokens";
  const { id } = accountVerify ?? (await api("GET", `${base}/verify`));

  const groups = await api("GET", `${base}/permission_groups`);
  const groupOf = ({ name, scope }) =>
    groups.find(
      (group) => group.name === name && (!group.scopes || group.scopes.includes(SCOPES[scope])),
    ) ?? fail(`no ${scope} permission group named ${name}`);
  const tokensWrite = groupOf({ name: TOKENS_WRITE, scope: "account" });

  const heldBy = (token) =>
    new Set(
      token.policies
        .filter((policy) => policy.effect === "allow")
        .flatMap((policy) => policy.permission_groups.map((group) => group.id)),
    );
  const runner = await api("GET", `${base}/${id}`);
  const held = heldBy(runner);
  const missing = RUNNER_GROUPS.map((wanted) => ({ ...wanted, group: groupOf(wanted) })).filter(
    ({ group }) => !held.has(group.id),
  );
  if (missing.length === 0) return;

  const zoneResource = async () => {
    const zones = await api(
      "GET",
      `/zones?name=${encodeURIComponent(zoneName)}&account.id=${accountId}`,
    );
    if (zones.length !== 1) fail(`the runner sees ${zones.length} zones named ${zoneName}`);
    return { [`${SCOPES.zone}.${zones[0].id}`]: "*" };
  };
  const resources = {
    account: { [`${SCOPES.account}.${accountId}`]: "*" },
    zone: missing.some(({ scope }) => scope === "zone") ? await zoneResource() : undefined,
  };

  await api("PUT", `${base}/${id}`, {
    name: runner.name,
    status: runner.status,
    policies: [
      ...runner.policies.map(({ effect, resources, permission_groups }) => ({
        effect,
        resources,
        permission_groups: permission_groups.map((group) => ({ id: group.id })),
      })),
      ...missing.map(({ scope, group }) => ({
        effect: "allow",
        resources: resources[scope],
        permission_groups: [{ id: group.id }],
      })),
    ],
    ...(runner.condition && { condition: runner.condition }),
    ...(runner.not_before && { not_before: runner.not_before }),
    ...(runner.expires_on && { expires_on: runner.expires_on }),
  });

  const after = heldBy(await api("GET", `${base}/${id}`));
  if (!after.has(tokensWrite.id))
    fail(`${TOKENS_WRITE} is gone from ${runner.name} after the update`);
  const absent = missing.filter(({ group }) => !after.has(group.id)).map(({ name }) => name);
  if (absent.length) fail(`${runner.name} still lacks ${absent.join(", ")} after the update`);
  console.log(
    `runner-grant: ${runner.name} now holds ${missing.map(({ name }) => name).join(", ")}`,
  );
};
