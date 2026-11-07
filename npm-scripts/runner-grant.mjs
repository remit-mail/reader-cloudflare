const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_SCOPE = "com.cloudflare.api.account";

export const RUNNER_GROUPS = [
  "Access: Organizations, Identity Providers, and Groups Write",
  "Email Sending Write",
];

const fail = (message) => {
  console.error(`runner-grant: ${message}`);
  process.exit(1);
};

export const grantRunner = async (token, accountId) => {
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
  const runner = await must("GET", `${base}/${id}`);
  const held = new Set(
    runner.policies
      .filter((policy) => policy.effect === "allow")
      .flatMap((policy) => policy.permission_groups.map((group) => group.id)),
  );

  const missing = RUNNER_GROUPS.map(
    (name) =>
      groups.find((group) => group.name === name) ?? fail(`no permission group named ${name}`),
  ).filter((group) => !held.has(group.id));
  if (missing.length === 0) return;

  const accountKey = `${ACCOUNT_SCOPE}.${accountId}`;
  const resourcesOf = (group) =>
    !group.scopes || group.scopes.includes(ACCOUNT_SCOPE)
      ? { [accountKey]: "*" }
      : { [accountKey]: { [`${ACCOUNT_SCOPE}.zone.*`]: "*" } };
  const added = missing.map((group) => ({
    effect: "allow",
    resources: resourcesOf(group),
    permission_groups: [{ id: group.id }],
  }));

  await must("PUT", `${base}/${id}`, {
    name: runner.name,
    status: runner.status,
    policies: [
      ...runner.policies.map(({ effect, resources, permission_groups }) => ({
        effect,
        resources,
        permission_groups: permission_groups.map((group) => ({ id: group.id })),
      })),
      ...added,
    ],
    ...(runner.condition && { condition: runner.condition }),
    ...(runner.not_before && { not_before: runner.not_before }),
    ...(runner.expires_on && { expires_on: runner.expires_on }),
  });
  console.log(`runner-grant: ${runner.name} now holds ${missing.map((g) => g.name).join(", ")}`);
};
