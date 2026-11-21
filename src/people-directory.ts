import type { PeopleDirectory } from "@remit/auth-service/people";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import type { Env } from "./env";

const revokeAppCredentials = async (env: Env, userId: string, disabled: boolean): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_oauth_access_token WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mcp_oauth_refresh_token WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mcp_session WHERE user_id = ?").bind(userId),
    ...(disabled
      ? [
          env.DB.prepare("DELETE FROM mcp_oauth_consent WHERE user_id = ?").bind(userId),
          env.DB.prepare("DELETE FROM mcp_device_code WHERE user_id = ?").bind(userId),
          env.DB.prepare("DELETE FROM calendar_feed_token WHERE account_config_id = ?").bind(
            deriveAccountConfigId(userId),
          ),
        ]
      : []),
  ]);
};

export const hostedPeopleDirectory = (env: Env): PeopleDirectory => ({
  listPeople: (request) => env.PEOPLE_DIRECTORY.listPeople(request),
  listAudit: (request) => env.PEOPLE_DIRECTORY.listAudit(request),
  invitePerson: (request) => env.PEOPLE_DIRECTORY.invitePerson(request),
  revokeInvite: (request) => env.PEOPLE_DIRECTORY.revokeInvite(request),
  createStepUp: (request) => env.PEOPLE_DIRECTORY.createStepUp(request),
  recordRefusal: (request) => env.PEOPLE_DIRECTORY.recordRefusal(request),

  resetPersonFactors: async (request) => {
    const outcome = await env.PEOPLE_DIRECTORY.resetPersonFactors(request);
    if (outcome.ok) await revokeAppCredentials(env, request.targetId, false);
    return outcome;
  },

  signOutPerson: async (request) => {
    const outcome = await env.PEOPLE_DIRECTORY.signOutPerson(request);
    if (outcome.ok) await revokeAppCredentials(env, request.targetId, false);
    return outcome;
  },

  updatePerson: async (request) => {
    const outcome = await env.PEOPLE_DIRECTORY.updatePerson(request);
    if (outcome.ok && request.status === "Disabled") {
      await revokeAppCredentials(env, request.targetId, true);
    }
    return outcome;
  },

  createPasswordReset: async (request) => {
    const outcome = await env.PEOPLE_DIRECTORY.createPasswordReset(request);
    if (outcome.ok) await revokeAppCredentials(env, request.targetId, false);
    return outcome;
  },
});
