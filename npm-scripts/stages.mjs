export const PROD = "prod";
export const DEV = "dev";

export const STAGES = {
  [DEV]: { cron: false, mailServer: false },
  [PROD]: { cron: true, mailServer: true },
};

export const MAIL_SERVER_FAMILIES = ["sync", "body", "mutation", "smtp"];

export const parseStage = (value = PROD) => {
  if (Object.hasOwn(STAGES, value)) return value;
  console.error(`unknown stage ${value}; pick one of ${Object.keys(STAGES).join(", ")}`);
  process.exit(2);
};

export const stageSuffix = (stage) => (stage === PROD ? "" : `-${stage}`);
