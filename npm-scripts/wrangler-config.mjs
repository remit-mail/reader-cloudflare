import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueFamilyOf } from "../src/queue/routing.ts";
import { MAIL_SERVER_FAMILIES, PROD, STAGES } from "./stages.mjs";

const root = join(import.meta.dirname, "..");

export const WRANGLER_CONFIG = join(root, "wrangler.jsonc");
export const WRANGLER_DEPLOY_CONFIG = join(root, "wrangler.deploy.jsonc");

const stripJsonc = (text) => {
  let out = "";
  let inString = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    const next = text[at + 1];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++at] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (at < text.length && text[at] !== "\n") at++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      at = text.indexOf("*/", at + 2) + 1;
      if (at === 0) throw new Error("wrangler config has an unterminated block comment");
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};

export const readJsonc = (path) => JSON.parse(stripJsonc(readFileSync(path, "utf8")));

const only = (entries, binding, what) => {
  if (entries?.length !== 1 || entries[0].binding !== binding) {
    throw new Error(`wrangler.jsonc must carry exactly one ${what}, bound as ${binding}`);
  }
  return entries[0];
};

export const CAPTURED_MAIL_ENTRYPOINT = "CapturedMailReader";

const capturesLoginMail = (stage) => {
  const { captureLoginMail } = STAGES[stage];
  if (captureLoginMail && stage === PROD) {
    throw new Error("prod sends login mail; captureLoginMail must stay off for prod");
  }
  return captureLoginMail;
};

export const renderWrangler = (base, outputs, config, stage) => {
  const { mailSync } = STAGES[stage];
  const captureLoginMail = capturesLoginMail(stage);
  const { env: _environments, routes: _routes, ...portable } = base;
  const queueOf = (queue) => {
    const name = outputs.queues[queueFamilyOf(queue)];
    if (name === undefined) throw new Error(`tofu outputs no queue for ${queue} in wrangler.jsonc`);
    return name;
  };
  const database = only(base.d1_databases, "DB", "D1 database");
  const bucket = only(base.r2_buckets, "MAIL", "R2 bucket");
  const secret = only(base.secrets_store_secrets, "MASTER_KEY", "Secrets Store secret");
  const microsoft = outputs.microsoft_oauth;
  const consumed = (consumer) =>
    mailSync || !MAIL_SERVER_FAMILIES.includes(queueFamilyOf(consumer.queue));
  return {
    ...portable,
    name: outputs.worker_name,
    account_id: config.account_id,
    triggers: mailSync ? base.triggers : { crons: [] },
    routes: [{ pattern: outputs.app_hostname, zone_name: config.zone_name, custom_domain: true }],
    vars: {
      ...base.vars,
      ACCESS_TEAM_DOMAIN: outputs.access_team_domain,
      ACCESS_AUD: outputs.access_aud,
      PUBLIC_ORIGIN: `https://${outputs.app_hostname}`,
      ...(microsoft && { MSOAUTH_CLIENT_ID: microsoft.client_id }),
      ...(captureLoginMail && { LOGIN_MAIL_READER: outputs.agent_client_id }),
    },
    ...(captureLoginMail && {
      services: [
        {
          binding: "LOGIN_MAIL",
          service: outputs.login_worker_name,
          entrypoint: CAPTURED_MAIL_ENTRYPOINT,
        },
      ],
    }),
    d1_databases: [
      { ...database, database_name: outputs.d1_database_name, database_id: outputs.d1_database_id },
    ],
    r2_buckets: [{ ...bucket, bucket_name: outputs.r2_bucket_name }],
    queues: {
      producers: base.queues.producers.map((producer) => ({
        ...producer,
        queue: queueOf(producer.queue),
      })),
      consumers: base.queues.consumers.filter(consumed).map((consumer) => ({
        ...consumer,
        queue: queueOf(consumer.queue),
        ...(consumer.dead_letter_queue && {
          dead_letter_queue: queueOf(consumer.dead_letter_queue),
        }),
      })),
    },
    secrets_store_secrets: [
      {
        ...secret,
        store_id: outputs.secrets_store_id,
        secret_name: outputs.master_key_secret_name,
      },
      ...(microsoft
        ? [
            {
              binding: "MSOAUTH_CLIENT_SECRET",
              store_id: outputs.secrets_store_id,
              secret_name: microsoft.secret_name,
            },
          ]
        : []),
    ],
  };
};

export const writeWranglerDeploy = (outputs, config, stage) => {
  const rendered = renderWrangler(readJsonc(WRANGLER_CONFIG), outputs, config, stage);
  writeFileSync(WRANGLER_DEPLOY_CONFIG, `${JSON.stringify(rendered, null, 2)}\n`);
  return rendered;
};

export const LOGIN_WRANGLER_CONFIG = join(root, "packages", "login", "wrangler.jsonc");
export const LOGIN_WRANGLER_DEPLOY_CONFIG = join(
  root,
  "packages",
  "login",
  "wrangler.deploy.jsonc",
);

export const loginAuthSecretName = (stage) =>
  stage === PROD ? "LOGIN_AUTH_SECRET" : `${stage.toUpperCase()}_LOGIN_AUTH_SECRET`;

export const renderLoginWrangler = (base, outputs, config, stage) => {
  const captureLoginMail = capturesLoginMail(stage);
  const { env: _environments, routes: _routes, send_email: _sendEmail, ...portable } = base;
  const database = only(base.d1_databases, "DB", "D1 database");
  const email = only(
    (base.send_email ?? []).map((binding) => ({ ...binding, binding: binding.name })),
    "EMAIL",
    "send_email binding",
  );
  return {
    ...portable,
    name: outputs.login_worker_name,
    account_id: config.account_id,
    routes: [{ pattern: outputs.login_hostname, zone_name: config.zone_name, custom_domain: true }],
    vars: {
      LOGIN_ORIGIN: `https://${outputs.login_hostname}`,
      READER_ORIGIN: `https://${outputs.app_hostname}`,
      LOGIN_OIDC_CLIENT_ID: outputs.login_oidc_client_id,
      EMAIL_SENDER: outputs.email_sender,
      OPERATOR_EMAILS: config.operator_emails.join(","),
      ...(captureLoginMail && { MAIL_CAPTURE: "on" }),
    },
    d1_databases: [
      {
        ...database,
        database_name: outputs.login_d1_database_name,
        database_id: outputs.login_d1_database_id,
      },
    ],
    ...(!captureLoginMail && {
      send_email: [{ name: email.name, allowed_sender_addresses: [outputs.email_sender] }],
    }),
    secrets_store_secrets: [
      {
        binding: "LOGIN_AUTH_SECRET",
        store_id: outputs.secrets_store_id,
        secret_name: loginAuthSecretName(stage),
      },
    ],
  };
};

export const writeLoginWranglerDeploy = (outputs, config, stage) => {
  const rendered = renderLoginWrangler(readJsonc(LOGIN_WRANGLER_CONFIG), outputs, config, stage);
  writeFileSync(LOGIN_WRANGLER_DEPLOY_CONFIG, `${JSON.stringify(rendered, null, 2)}\n`);
  return rendered;
};
