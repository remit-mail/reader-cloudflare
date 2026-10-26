import { appApi } from "./app-api.mjs";

const [method, path, json] = process.argv.slice(2);
if (method === undefined || path === undefined || !path.startsWith("/")) {
  console.error("usage: npm run api -- <METHOD> </api/path> [json-body]");
  process.exit(2);
}

const request = appApi();
const response = await request(
  method.toUpperCase(),
  path,
  json === undefined ? undefined : JSON.parse(json),
);
console.log(`${response.status} ${response.ms}ms`);
console.log(
  typeof response.body === "string" ? response.body : JSON.stringify(response.body, null, 2),
);
if (!response.ok) process.exit(1);
