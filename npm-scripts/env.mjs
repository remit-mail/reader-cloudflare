import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

export const PROJECT =
  process.env.DEPLOY_PROJECT || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
export const CONFIG_DIR = join(homedir(), ".config", PROJECT);
export const CF_ENV = join(CONFIG_DIR, "cf-env");
export const CF_USER_ENV = join(CONFIG_DIR, "cf-user-env");
export const DEBUG_TOKEN_SECRET = `${PROJECT}-debug-token`;
export const ACCESS_ENV = join(CONFIG_DIR, "access-env");
export const ACCESS_ENV_SECRET = `${PROJECT}-access-env`;
export const TEST_ACCOUNT_ENV = join(CONFIG_DIR, "test-account-env");

export const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.replace(/^\s*export\s+/, "").trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).replace(/^(["'])(.*)\1$/, "$2")];
      }),
  );

export const readEnvFile = (path) => (existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {});
