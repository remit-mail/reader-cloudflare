import { createHash } from "node:crypto";
import { deriveUserId } from "../src/mail/ids.ts";

const USER_ID_LENGTH = 25;

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

const accountSettingId = (accountConfigId, name) =>
  createHash("sha256").update(`accountSetting:${accountConfigId}:${name}`).digest("hex");

export const rekeyAppDb = async (query) => {
  const configs = await query(
    `select account_config_id, user_id from account_config where length(user_id) != ${USER_ID_LENGTH}`,
  );
  for (const config of configs) {
    const userId = await deriveUserId(config.user_id);
    await query(
      `update account_config set user_id = ${quote(userId)} where account_config_id = ${quote(config.account_config_id)}`,
    );
  }
  const settings = await query(
    "select account_setting_id, account_config_id, name from account_setting",
  );
  const stale = settings.filter(
    (setting) =>
      setting.account_setting_id !== accountSettingId(setting.account_config_id, setting.name),
  );
  for (const setting of stale) {
    await query(
      `update or replace account_setting set account_setting_id = ${quote(accountSettingId(setting.account_config_id, setting.name))} where account_setting_id = ${quote(setting.account_setting_id)}`,
    );
  }
  console.log(
    JSON.stringify({
      step: "rekey app db",
      accountConfigs: configs.length,
      accountSettings: stale.length,
    }),
  );
};
