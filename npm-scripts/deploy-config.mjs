import { join } from "node:path";
import { z } from "zod";
import { CONFIG_DIR, PROJECT } from "./env.mjs";
import { PROD } from "./stages.mjs";

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "a lower case DNS name",
  );

const inZone = (name, zone) => name === zone || name.endsWith(`.${zone}`);

export const deployConfigSchema = z
  .object({
    account_id: z.string().regex(/^[0-9a-f]{32}$/, "a 32 character Cloudflare account id"),
    zone_name: hostname,
    app_hostname: hostname,
    dev_app_hostname: hostname,
    owner_emails: z.array(z.string().email()).min(1),
    alert_email: z.string().email(),
    msoauth: z
      .object({ client_id: z.string().min(1), client_secret: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((config) => inZone(config.app_hostname, config.zone_name), {
    message: "app_hostname must sit in zone_name",
    path: ["app_hostname"],
  })
  .refine((config) => inZone(config.dev_app_hostname, config.zone_name), {
    message: "dev_app_hostname must sit in zone_name",
    path: ["dev_app_hostname"],
  })
  .refine((config) => config.dev_app_hostname !== config.app_hostname, {
    message: "dev_app_hostname must differ from app_hostname",
    path: ["dev_app_hostname"],
  });

export const DEPLOY_CONFIG_OBJECT = "deploy.config.json";

export const DEPLOY_CONFIG_FILE = join(CONFIG_DIR, DEPLOY_CONFIG_OBJECT);
export const DEPLOY_CONFIG_SECRET = `${PROJECT}-deploy-config`;

export const deployVariable = (field) => `DEPLOY_${field.toUpperCase()}`;

export const deployConfigFromEnv = (env) => {
  const config = {};
  for (const field of Object.keys(deployConfigSchema.shape)) {
    const value = env[deployVariable(field)];
    if (value === undefined) continue;
    if (!/^[[{]/.test(value)) {
      config[field] = value;
      continue;
    }
    try {
      config[field] = JSON.parse(value);
    } catch {
      console.error(`${deployVariable(field)} is not valid JSON`);
      process.exit(1);
    }
  }
  return JSON.stringify(config);
};

export const parseDeployConfig = (text, source) => {
  const parsed = deployConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    console.error(`${source} is not a valid deploy config:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  return parsed.data;
};

const stageConfig = ({ dev_app_hostname, msoauth, ...shared }, stage) =>
  stage === PROD
    ? { ...shared, ...(msoauth && { msoauth }) }
    : { ...shared, app_hostname: dev_app_hostname };

export const tofuVars = (config, stage) => ({
  TF_VAR_project: PROJECT,
  TF_VAR_stage: stage,
  ...Object.fromEntries(
    Object.entries(stageConfig(config, stage)).map(([key, value]) => [
      `TF_VAR_${key}`,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  ),
});

export const configLiterals = ({ owner_emails, alert_email, msoauth, ...rest }) => {
  const emails = [...owner_emails, alert_email];
  return [
    ...new Set([
      ...Object.values(rest),
      ...Object.values(msoauth ?? {}),
      ...emails,
      ...emails.map((email) => email.split("@")[1]),
    ]),
  ];
};
