import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configLiterals, DEPLOY_CONFIG_FILE, DEPLOY_CONFIG_OBJECT } from "./deploy-config.mjs";
import { TOFU_SHA256 } from "./tofu.mjs";

const root = join(import.meta.dirname, "..");

const SKIPPED = [
  /^package-lock\.json$/,
  /^infra\/\.terraform\.lock\.hcl$/,
  /^migrations\/(mail\/)?meta\//,
];

const ALLOWED_EMAIL_DOMAINS = ["example.com", "example.org", "users.noreply.github.com"];
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];
const ALLOWED_VALUES = new Set([
  "0".repeat(32),
  "00000000-0000-0000-0000-000000000000",
  "example.cloudflareaccess.com",
  ...Object.values(TOFU_SHA256),
]);

const SHAPES = [
  ["a 32 character hex id (account, zone, Secrets Store)", /\b[0-9a-f]{32}\b/g],
  ["a 64 character hex value (Access audience)", /\b[0-9a-f]{64}\b/g],
  ["a UUID (D1 database id)", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g],
  ["an Access team domain", /\b[a-z0-9-]+\.cloudflareaccess\.com\b/g],
  ["an e-mail address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
];

const isAllowed = (value) => {
  if (ALLOWED_VALUES.has(value)) return true;
  const at = value.lastIndexOf("@");
  if (at === -1) return false;
  const domain = value.slice(at + 1).toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain) || RESERVED_TLDS.includes(domain.split(".").at(-1));
};

export const scanRepo = (literals) => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !SKIPPED.some((pattern) => pattern.test(file)))
    .filter((file) => existsSync(join(root, file)));
  const hits = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      for (const [what, pattern] of SHAPES) {
        for (const [value] of line.matchAll(pattern)) {
          if (!isAllowed(value)) hits.push(`${where}: ${what}: ${value}`);
        }
      }
      for (const literal of literals) {
        if (line.includes(literal)) hits.push(`${where}: a value from ${DEPLOY_CONFIG_OBJECT}`);
      }
    });
  }
  return { files: files.length, hits };
};

export const failOnHits = ({ hits }) => {
  if (hits.length === 0) return;
  for (const hit of hits) console.error(`check:no-config: ${hit}`);
  console.error(
    "check:no-config: deployment values belong in deploy.config.json and tofu outputs, never in the repo",
  );
  process.exit(1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configFiles = [DEPLOY_CONFIG_FILE, join(root, DEPLOY_CONFIG_OBJECT)].filter((file) =>
    existsSync(file),
  );
  const literals = [
    ...new Set(
      configFiles.flatMap((file) => configLiterals(JSON.parse(readFileSync(file, "utf8")))),
    ),
  ];
  const scan = scanRepo(literals);
  failOnHits(scan);
  console.log(
    `check:no-config: ${scan.files} files carry no deployment value${literals.length ? `, including the ${literals.length} in ${configFiles.join(" and ")}` : ""}`,
  );
}
