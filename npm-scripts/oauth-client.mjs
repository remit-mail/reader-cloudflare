const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const oauthClientUpsertSql = ({ clientId, secretHash, redirectUri, now }) => {
  const row = {
    id: clientId,
    client_id: clientId,
    client_secret: secretHash,
    disabled: 0,
    skip_consent: 1,
    scopes: JSON.stringify(["openid", "email", "profile"]),
    redirect_uris: JSON.stringify([redirectUri]),
    token_endpoint_auth_method: "client_secret_post",
    grant_types: JSON.stringify(["authorization_code"]),
    response_types: JSON.stringify(["code"]),
    require_pkce: 1,
    application_type: "web",
    created_at: now,
    updated_at: now,
    name: "Cloudflare Access",
  };
  const columns = Object.keys(row);
  const values = Object.values(row).map((value) =>
    typeof value === "number" ? String(value) : sqlText(value),
  );
  const updates = columns
    .filter((column) => column !== "id" && column !== "client_id" && column !== "created_at")
    .map((column) => `${column} = excluded.${column}`);
  return `INSERT INTO oauth_client (${columns.join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT (client_id) DO UPDATE SET ${updates.join(", ")}`;
};
