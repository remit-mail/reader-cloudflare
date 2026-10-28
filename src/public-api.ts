import { oauthRefusalUrl, verifyState } from "@remit/backend/oauth-state";
import {
  hashCalendarFeedToken,
  isCalendarFeedToken,
  readCalendarFeedToken,
  redactCalendarFeedPath,
} from "@remit/calendar-service";
import { apiConfig } from "./api/config";
import { API_ROOT } from "./api/paths";
import type { Env } from "./env";
import { tenantOfAccountConfig, tenantOfFeedToken } from "./tenant-directory";

export type CallbackTenant =
  | { readonly ok: true; readonly tenantId: string }
  | { readonly ok: false; readonly oauthError: "config_error" | "invalid_state" };

export const calendarFeedTenant = async (env: Env, url: URL): Promise<string | undefined> => {
  const token = readCalendarFeedToken(url.pathname.slice(API_ROOT.length));
  if (token === null || !isCalendarFeedToken(token)) return undefined;
  return tenantOfFeedToken(env.DB, hashCalendarFeedToken(token));
};

export const feedNotFound = (): Response =>
  new Response("no calendar feed at this address\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export const microsoftCallbackTenant = async (env: Env, url: URL): Promise<CallbackTenant> => {
  const { msOAuth } = apiConfig;
  if (msOAuth.mode === "Disabled") return { ok: false, oauthError: "config_error" };
  const { clientSecret } = await msOAuth.credentials();
  const state = await verifyState(url.searchParams.get("state") ?? "", clientSecret).then(
    (verified) => verified,
    () => undefined,
  );
  if (state === undefined) return { ok: false, oauthError: "invalid_state" };
  const tenantId = await tenantOfAccountConfig(env.DB, state.accountConfigId);
  if (tenantId === undefined) return { ok: false, oauthError: "invalid_state" };
  return { ok: true, tenantId };
};

export const oauthRefused = (env: Env, oauthError: string): Response =>
  Response.redirect(oauthRefusalUrl(env.PUBLIC_ORIGIN, oauthError), 302);

export const loggedPath = (pathname: string): string =>
  pathname.startsWith(`${API_ROOT}/`)
    ? `${API_ROOT}${redactCalendarFeedPath(pathname.slice(API_ROOT.length))}`
    : pathname;
