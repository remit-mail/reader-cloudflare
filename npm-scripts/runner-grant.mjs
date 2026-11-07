const API = "https://api.cloudflare.com/client/v4";
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
  const call = async (method, path, body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({ success: false, errors: [] }));
    if (response.ok && json.success) return { ok: true, result: json.result };
    const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
    return { ok: false, message: `${method} ${path} returned ${response.status}: ${errors}` };
  };
  const must = async (method, path, body) => {
    const response = await call(method, path, body);
    if (!response.ok) fail(response.message);
    return response.result;
  };

  const accountBase = `/accounts/${accountId}/tokens`;
  const accountVerify = await call("GET", `${accountBase}/verify`);
  const base = accountVerify.ok ? accountBase : "/user/tokens";
  const { id } = accountVerify.ok ? accountVerify.result : await must("GET", `${base}/verify`);

  const groups = await must("GET", `${base}/permission_groups`);
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
  const runner = await must("GET", `${base}/${id}`);
  const held = heldBy(runner);
  const missing = RUNNER_GROUPS.map((wanted) => ({ ...wanted, group: groupOf(wanted) })).filter(
    ({ group }) => !held.has(group.id),
  );
  if (missing.length === 0) return;

  const zoneResource = async () => {
    const zones = await must(
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

  await must("PUT", `${base}/${id}`, {
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

  const after = heldBy(await must("GET", `${base}/${id}`));
  if (!after.has(tokensWrite.id))
    fail(`${TOKENS_WRITE} is gone from ${runner.name} after the update`);
  const absent = missing.filter(({ group }) => !after.has(group.id)).map(({ name }) => name);
  if (absent.length) fail(`${runner.name} still lacks ${absent.join(", ")} after the update`);
  console.log(
    `runner-grant: ${runner.name} now holds ${missing.map(({ name }) => name).join(", ")}`,
  );
};
