import { configOperationsGetConfig } from "@remit/api-http-client";
import { client } from "@remit/api-http-client/client.gen.ts";
import { accessEnvOf, readEnvFile } from "./env.mjs";
import { DEV } from "./stages.mjs";

const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 5_000;

export interface Target {
  readonly appUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const TARGET_VARS = ["APP_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"] as const;

export const devTarget = (): Target => {
  const fromProcess = TARGET_VARS.every((name) => process.env[name]);
  const env: Record<string, string | undefined> = fromProcess
    ? process.env
    : readEnvFile(accessEnvOf(DEV));
  const [appUrl, clientId, clientSecret] = TARGET_VARS.map((name) => env[name]);
  if (!appUrl || !clientId || !clientSecret) {
    console.error(
      `set ${TARGET_VARS.join(", ")} or write ${accessEnvOf(DEV)} with npm run access-env:write -- ${DEV}`,
    );
    process.exit(1);
  }
  return { appUrl, clientId, clientSecret };
};

export const accessHeaders = (target: Target): Record<string, string> => ({
  "CF-Access-Client-Id": target.clientId,
  "CF-Access-Client-Secret": target.clientSecret,
});

interface Outcome<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: Response;
}

const fail = (step: string, outcome: Outcome<unknown>): never => {
  console.error(
    `${step}: ${outcome.response?.status ?? "no response"} ${JSON.stringify(outcome.error)}`,
  );
  process.exit(1);
};

export const must = async <T>(step: string, call: Promise<Outcome<T>>): Promise<T> => {
  const outcome = await call;
  if (outcome.error !== undefined || outcome.data === undefined) return fail(step, outcome);
  console.log(`${step}: ${outcome.response?.status}`);
  return outcome.data;
};

export const succeeds = async (step: string, call: Promise<Outcome<unknown>>): Promise<void> => {
  const outcome = await call;
  if (outcome.error !== undefined) fail(step, outcome);
  console.log(`${step}: ${outcome.response?.status}`);
};

const expectedCommit = process.env.WORKERS_CI_COMMIT_SHA;

const isServing = async (): Promise<boolean> => {
  const outcome = await configOperationsGetConfig().catch((error: unknown) => {
    console.log(`waiting for the deploy: ${error instanceof Error ? error.message : error}`);
    return undefined;
  });
  if (outcome === undefined) return false;
  if (outcome.data === undefined) {
    console.log(`waiting for the deploy: GET /api/config answered ${outcome.response?.status}`);
    return false;
  }
  if (expectedCommit === undefined || outcome.data.buildCommit === expectedCommit) return true;
  console.log(`waiting for the deploy: serving ${outcome.data.buildCommit}, not ${expectedCommit}`);
  return false;
};

export const connect = async (): Promise<Target> => {
  const target = devTarget();
  client.setConfig({
    baseUrl: new URL("/api", target.appUrl).href,
    headers: accessHeaders(target),
  });
  const started = Date.now();
  while (!(await isServing())) {
    if (Date.now() - started > READY_TIMEOUT_MS) {
      console.error(
        `${target.appUrl} did not serve ${expectedCommit ?? "the API"} within ${READY_TIMEOUT_MS / 60_000} minutes`,
      );
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return target;
};
