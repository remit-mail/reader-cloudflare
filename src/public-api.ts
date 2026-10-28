import {
  hashCalendarFeedToken,
  isCalendarFeedToken,
  readCalendarFeedToken,
  redactCalendarFeedPath,
} from "@remit/calendar-service";
import { base64UrlDecode, parseJson } from "./access";
import { API_ROOT, CALENDAR_FEED_ROOT, MICROSOFT_OAUTH_CALLBACK } from "./api/paths";
import type { Env } from "./env";
import { tenantOfAccountConfig, tenantOfFeedToken } from "./tenant-directory";

export interface PublicRoute {
  readonly name: "calendarFeed" | "microsoftOAuthCallback";
  readonly tenantOf: (env: Env, url: URL) => Promise<string | undefined>;
  readonly unresolved: (env: Env) => Response;
}

interface SignedState {
  readonly accountConfigId: string;
}

const isSignedState = (value: unknown): value is SignedState =>
  typeof value === "object" &&
  value !== null &&
  "accountConfigId" in value &&
  typeof value.accountConfigId === "string";

const feedTenant = async (env: Env, url: URL): Promise<string | undefined> => {
  const token = readCalendarFeedToken(url.pathname.slice(API_ROOT.length));
  if (token === null || !isCalendarFeedToken(token)) return undefined;
  return tenantOfFeedToken(env.DB, hashCalendarFeedToken(token));
};

// Reader verifies the state's signature inside the tenant object; the Worker
// reads the unverified payload only to pick that object.
const callbackTenant = async (env: Env, url: URL): Promise<string | undefined> => {
  const state = url.searchParams.get("state") ?? "";
  const dot = state.lastIndexOf(".");
  if (dot === -1) return undefined;
  const payload = parseJson(base64UrlDecode(state.slice(0, dot)));
  if (!isSignedState(payload)) return undefined;
  return tenantOfAccountConfig(env.DB, payload.accountConfigId);
};

const calendarFeed: PublicRoute = {
  name: "calendarFeed",
  tenantOf: feedTenant,
  unresolved: () =>
    new Response("no calendar feed at this address\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
};

const microsoftOAuthCallback: PublicRoute = {
  name: "microsoftOAuthCallback",
  tenantOf: callbackTenant,
  unresolved: (env) =>
    Response.redirect(`${env.PUBLIC_ORIGIN}/settings/accounts?oauthError=invalid_state`, 302),
};

export const publicRouteOf = (pathname: string): PublicRoute | undefined => {
  if (pathname.startsWith(CALENDAR_FEED_ROOT)) return calendarFeed;
  if (pathname === MICROSOFT_OAUTH_CALLBACK) return microsoftOAuthCallback;
  return undefined;
};

export const loggedPath = (pathname: string): string =>
  pathname.startsWith(`${API_ROOT}/`)
    ? `${API_ROOT}${redactCalendarFeedPath(pathname.slice(API_ROOT.length))}`
    : pathname;
