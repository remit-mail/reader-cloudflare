import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const INFRA_DIR = join(root, "infra");
export const TFSTATE_BUCKET = "reader-cloudflare-tfstate";
export const TFSTATE_KEY = "reader-cloudflare.tfstate";
export const TOFU_VERSION = "1.13.2";

const TOFU_SHA256 = {
  amd64: "ac05d9952662c7db28dd57e93f0a68018837bfdf9342384ec0987977c16a9645",
  arm64: "88e2d9e3f94f97b76ab2faf55ade87578f56aed19c5e45fa139d70e994366d1f",
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const r2Endpoint = (accountId) => `https://${accountId}.r2.cloudflarestorage.com`;

export const requireEnv = (names, hint) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  console.error(`${missing.join(", ")} not set in the environment; ${hint}`);
  process.exit(1);
};

const tofuBinary = async () => {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (process.platform !== "linux" || !arch) {
    console.error(`no pinned OpenTofu for ${process.platform}/${process.arch}`);
    process.exit(1);
  }
  const dir = join(root, ".tmp", "tofu", TOFU_VERSION);
  const binary = join(dir, "tofu");
  if (existsSync(binary)) return binary;
  const name = `tofu_${TOFU_VERSION}_linux_${arch}.tar.gz`;
  const url = `https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  if (sha256(tarball) !== TOFU_SHA256[arch]) throw new Error(`${name} failed its sha256 check`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, name);
  writeFileSync(archive, tarball);
  const untar = spawnSync("tar", ["-xzf", archive, "-C", dir, "tofu"], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error(`tar -xzf ${name} exited with ${untar.status}`);
  rmSync(archive);
  return binary;
};

export const tofuEnv = ({ accountId, apiToken, accessKeyId, secretAccessKey }) => ({
  ...process.env,
  TF_IN_AUTOMATION: "1",
  TF_VAR_account_id: accountId,
  CLOUDFLARE_API_TOKEN: apiToken,
  AWS_ACCESS_KEY_ID: accessKeyId,
  AWS_SECRET_ACCESS_KEY: secretAccessKey,
  AWS_ENDPOINT_URL_S3: r2Endpoint(accountId),
});

export const tofuRunner = async (env) => {
  const binary = await tofuBinary();
  return (args, stdout = "inherit") => {
    const run = spawnSync(binary, args, {
      cwd: INFRA_DIR,
      env,
      stdio: ["ignore", stdout, "inherit"],
      encoding: "utf8",
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      console.error(`tofu ${args[0]} exited with ${run.status}`);
      process.exit(run.status ?? 1);
    }
    return run.stdout;
  };
};

export const TOFU_INIT = ["init", "-input=false", "-reconfigure"];

const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

const r2Get = async ({ accountId, accessKeyId, secretAccessKey }, bucket, key) => {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const payloadHash = sha256("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    path,
    "",
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = ["auto", "s3", "aws4_request"].reduce(
    hmac,
    hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8)),
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const response = await fetch(`https://${host}${path}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (!response.ok) throw new Error(`GET r2://${bucket}/${key} returned ${response.status}`);
  return response.text();
};

export const readStateOutputs = async (credentials) => {
  const state = JSON.parse(await r2Get(credentials, TFSTATE_BUCKET, TFSTATE_KEY));
  return (name) => {
    const value = state.outputs?.[name]?.value;
    if (!value) {
      console.error(`the remote state has no output ${name}`);
      process.exit(1);
    }
    return value;
  };
};
