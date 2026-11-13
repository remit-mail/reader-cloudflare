import type { SpamDeployment } from "@remit/data-ports";
import type { Env } from "../env";

type SpamEnv = Pick<Env, "SPAM_BACKEND" | "SPAM_CLEAN_BELOW" | "SPAM_AT" | "SPAM_RSPAMD_URL">;

type Thresholds = Extract<SpamDeployment, { name: "Inline" }>["thresholds"];

const refuse = (message: string): never => {
  throw new Error(`Refusing to start: ${message}`);
};

const trimmed = (raw: string | undefined): string => (raw ?? "").trim();

const scoreOf = (key: string, raw: string): number => {
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(raw))
    return refuse(`${key}=${raw} must be a number from 0 to 1.`);
  return Number(raw);
};

const thresholdsOf = (env: SpamEnv): Thresholds => {
  const cleanBelow = trimmed(env.SPAM_CLEAN_BELOW);
  const spamAt = trimmed(env.SPAM_AT);
  if (cleanBelow === "" && spamAt === "") return { state: "Unset" };
  if (cleanBelow === "" || spamAt === "")
    return refuse("set both SPAM_CLEAN_BELOW and SPAM_AT, or neither.");
  const thresholds = {
    state: "Set" as const,
    cleanBelow: scoreOf("SPAM_CLEAN_BELOW", cleanBelow),
    spamAt: scoreOf("SPAM_AT", spamAt),
  };
  if (thresholds.cleanBelow > thresholds.spamAt)
    return refuse("SPAM_CLEAN_BELOW must not exceed SPAM_AT.");
  return thresholds;
};

const rspamdOf = (env: SpamEnv): SpamDeployment => {
  if (trimmed(env.SPAM_CLEAN_BELOW) !== "" || trimmed(env.SPAM_AT) !== "") {
    return refuse(
      "SPAM_CLEAN_BELOW and SPAM_AT do not apply with SPAM_BACKEND=Rspamd, which picks its own action.",
    );
  }
  const url = trimmed(env.SPAM_RSPAMD_URL);
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    return refuse(`SPAM_RSPAMD_URL=${url} must be an http or https URL with SPAM_BACKEND=Rspamd.`);
  }
  return { name: "Rspamd", url };
};

export const spamDeploymentOf = (env: SpamEnv): SpamDeployment => {
  const backend = trimmed(env.SPAM_BACKEND);
  if (backend === "Rspamd") return rspamdOf(env);
  if (backend !== "" && backend !== "Inline") {
    return refuse(`SPAM_BACKEND=${backend} is not a known backend. Use Inline or Rspamd.`);
  }
  if (trimmed(env.SPAM_RSPAMD_URL) !== "")
    return refuse("SPAM_RSPAMD_URL set without SPAM_BACKEND=Rspamd.");
  return { name: "Inline", thresholds: thresholdsOf(env) };
};
