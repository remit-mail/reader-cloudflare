import { deviceLogin } from "@remit/mcp-server/app";
import { accessEnvOf, readEnvFile } from "./env.mjs";
import { parseStage } from "./stages.mjs";

const stage = parseStage(process.argv[2]);
const appUrl = readEnvFile(accessEnvOf(stage)).APP_URL;
if (!appUrl) {
  console.error(
    `${accessEnvOf(stage)} does not set APP_URL; run npm run access-env:write ${stage}`,
  );
  process.exit(1);
}

const result = await deviceLogin(new URL(appUrl).origin, {
  fetch,
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
if (!result.ok) {
  console.error(`mcp login failed: ${result.error} ${result.description}`);
  process.exit(1);
}
console.log(result.command);
