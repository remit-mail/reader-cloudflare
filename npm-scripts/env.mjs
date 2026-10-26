import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "reader-cloudflare");
export const CF_ENV = join(CONFIG_DIR, "cf-env");
export const CF_BOOTSTRAP_ENV = join(CONFIG_DIR, "cf-bootstrap-env");
export const TFSTATE = join(CONFIG_DIR, "terraform.tfstate");
export const TOFU_INIT = [
  "init",
  "-input=false",
  "-reconfigure",
  `-backend-config=path=${TFSTATE}`,
];
export const ACCESS_ENV = join(CONFIG_DIR, "access-env");
export const TEST_ACCOUNT_ENV = join(CONFIG_DIR, "test-account-env");
export const APP_URL = "https://app.remit.email";

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
