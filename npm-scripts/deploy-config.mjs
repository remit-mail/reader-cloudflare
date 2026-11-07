import { join } from "node:path";
import { z } from "zod";
import { r2ObjectText } from "./cf-api.mjs";
import { CONFIG_DIR, PROJECT } from "./env.mjs";
import { PROD, STAGES } from "./stages.mjs";
import { BUILDER_SECRETS_BUCKET } from "./tofu.mjs";

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "a lower case DNS name",
  );

const inZone = (name, zone) => name === zone || name.endsWith(`.${zone}`);

const domainOf = (email) => email.slice(email.lastIndexOf("@") + 1);

const lowerEmail = z
  .string()
  .email()
  .refine((email) => email === email.toLowerCase(), "a lower case e-mail address");

const HOSTNAME_FIELDS = [
  "app_hostname",
  "dev_app_hostname",
  "login_hostname",
  "dev_login_hostname",
];
const SENDER_FIELDS = ["email_sender", "dev_email_sender"];

export const deployConfigSchema = z
  .object({
    account_id: z.string().regex(/^[0-9a-f]{32}$/, "a 32 character Cloudflare account id"),
    zone_name: hostname,
    app_hostname: hostname,
    dev_app_hostname: hostname,
    owner_emails: z.array(z.string().email()).min(1),
    alert_email: z.string().email(),
    login_hostname: hostname,
    dev_login_hostname: hostname,
    email_sender: lowerEmail,
    dev_email_sender: lowerEmail,
    operator_emails: z.array(lowerEmail).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    for (const field of HOSTNAME_FIELDS) {
      if (!inZone(config[field], config.zone_name)) {
        context.addIssue({
          code: "custom",
          message: `${field} must sit in zone_name`,
          path: [field],
        });
      }
      const clash = HOSTNAME_FIELDS.find(
        (other) => other !== field && config[other] === config[field],
      );
      if (clash) {
        context.addIssue({
          code: "custom",
          message: `${field} must differ from ${clash}`,
          path: [field],
        });
      }
    }
    for (const field of SENDER_FIELDS) {
      if (!inZone(domainOf(config[field]), config.zone_name)) {
        context.addIssue({
          code: "custom",
          message: `the domain of ${field} must sit in zone_name`,
          path: [field],
        });
      }
    }
    if (domainOf(config.dev_email_sender) === domainOf(config.email_sender)) {
      context.addIssue({
        code: "custom",
        message:
          "dev_email_sender must use a different domain than email_sender; each stage owns its sending subdomain",
        path: ["dev_email_sender"],
      });
    }
  });

export const deploySecretsSchema = z
  .object({
    msoauth: z
      .object({ client_id: z.string().min(1), client_secret: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const DEPLOY_CONFIG_OBJECT = "deploy.config.json";
export const DEPLOY_SECRETS_OBJECT = "deploy.secrets.json";
export const DEPLOY_CONFIG_FILE = join(CONFIG_DIR, DEPLOY_CONFIG_OBJECT);
export const BUILDS_BOOTSTRAP_REPO = "mvhenten/cloudflare-builds-bootstrap";
export const BUILDS_BOOTSTRAP_PROJECTS = "infra/projects.auto.tfvars.json";

const parseWith = (schema, label) => (text, source) => {
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      console.error(`${source} is not JSON`);
      process.exit(1);
    }
  })();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    console.error(`${source} is not a valid ${label}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  return parsed.data;
};

export const parseDeployConfig = parseWith(deployConfigSchema, "deploy config");
const parseDeploySecrets = parseWith(deploySecretsSchema, "deploy secrets object");

export const readDeploySecrets = async (token, accountId) => {
  const source = `r2://${BUILDER_SECRETS_BUCKET}/${DEPLOY_SECRETS_OBJECT}`;
  const object = await r2ObjectText(
    token,
    accountId,
    BUILDER_SECRETS_BUCKET,
    DEPLOY_SECRETS_OBJECT,
  );
  if (object.status === 404) return {};
  if (!object.ok) {
    console.error(`reading ${source} returned ${object.status}`);
    process.exit(1);
  }
  return parseDeploySecrets(object.text, source);
};

export const stageConfig = (
  { dev_app_hostname, dev_login_hostname, dev_email_sender, msoauth, ...shared },
  stage,
) =>
  stage === PROD
    ? { ...shared, ...(msoauth && { msoauth }) }
    : {
        ...shared,
        app_hostname: dev_app_hostname,
        login_hostname: dev_login_hostname,
        email_sender: dev_email_sender,
      };

export const tofuVars = (config, stage) => {
  const { operator_emails: _operators, ...infra } = stageConfig(config, stage);
  return {
    TF_VAR_project: PROJECT,
    TF_VAR_stage: stage,
    TF_VAR_login_idp: String(STAGES[stage].loginIdp),
    ...Object.fromEntries(
      Object.entries(infra).map(([key, value]) => [
        `TF_VAR_${key}`,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    ),
  };
};

export const configLiterals = ({
  owner_emails,
  alert_email,
  operator_emails,
  email_sender,
  dev_email_sender,
  msoauth,
  ...rest
}) => {
  const emails = [
    ...owner_emails,
    alert_email,
    ...operator_emails,
    email_sender,
    dev_email_sender,
  ];
  return [
    ...new Set([
      ...Object.values(rest),
      ...Object.values(msoauth ?? {}),
      ...emails,
      ...emails.map((email) => email.split("@")[1]),
    ]),
  ];
};
