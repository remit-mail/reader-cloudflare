import { ACCESS_ENV, readEnvFile } from "./env.mjs";

export const appApi = () => {
  const env = readEnvFile(ACCESS_ENV);
  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  const appUrl = env.APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    console.error(
      `${ACCESS_ENV} does not set APP_URL, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; run npm run access-env:write`,
    );
    process.exit(1);
  }
  return async (method, path, body) => {
    const headers = {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const started = Date.now();
    const response = await fetch(new URL(path, appUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    return {
      status: response.status,
      ok: response.ok,
      body: isJson && text !== "" ? JSON.parse(text) : text,
      ms: Date.now() - started,
    };
  };
};
