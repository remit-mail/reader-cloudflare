import {
  calendarEventDetailOperationsDeleteCalendarEvent,
  calendarEventOperationsCreateCalendarEvent,
  calendarEventOperationsListCalendarEvents,
  calendarOperationsListCalendars,
  outboxOperationsListOutboxMessages,
  unifiedThreadOperationsListAllThreads,
} from "@remit/api-http-client";
import { accessHeaders, connect, must, succeeds } from "./dev-api.ts";
import { CALENDAR, DRAFTS, WEEKLY_SUMMARY } from "./dev-fixtures.ts";
import { fetchOnceServed } from "./host-ready.ts";
import { callMcp, MCP_PROTOCOL_VERSION } from "./smoke-mcp.ts";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+00:00");

const check = (step: string, ok: boolean, detail: string): void => {
  if (ok) {
    console.log(`${step}: ok`);
    return;
  }
  console.error(`${step}: ${detail}`);
  process.exit(1);
};

const started = Date.now();
const target = await connect();

const loginUrl = process.env.LOGIN_URL;
if (!loginUrl) {
  console.error("set LOGIN_URL to the dev login origin, https://<dev_login_hostname>");
  process.exit(1);
}
const discovery = await fetchOnceServed(
  new URL("/api/auth/.well-known/openid-configuration", loginUrl),
);
const issuer = discovery.ok ? ((await discovery.json()) as { issuer?: unknown }).issuer : undefined;
check(
  "login openid configuration",
  discovery.status === 200 && issuer === `${loginUrl}/api/auth`,
  `GET /api/auth/.well-known/openid-configuration answered ${discovery.status} with issuer ${String(issuer)}`,
);
const agentOnLogin = await fetch(new URL("/sign-in", loginUrl), {
  headers: accessHeaders(target),
  redirect: "manual",
});
check(
  "login refuses the agent token",
  agentOnLogin.status === 403,
  `GET /sign-in with the agent service token answered ${agentOnLogin.status}`,
);

const anonymous = await fetch(new URL("/api/config", target.appUrl), { redirect: "manual" });
check(
  "access refuses an anonymous call",
  anonymous.status === 302 || anonymous.status === 401 || anonymous.status === 403,
  `GET /api/config without a service token answered ${anonymous.status}`,
);

const installationAssets = [
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "application/javascript"],
  ["/apple-touch-icon.png", "image/png"],
  ["/favicon.ico", "image/x-icon"],
  ["/icons/icon-192.png", "image/png"],
  ["/icons/icon-512.png", "image/png"],
  ["/icons/icon-maskable-512.png", "image/png"],
] as const;
for (const [path, mime] of installationAssets) {
  const response = await fetch(new URL(path, target.appUrl), { redirect: "manual" });
  check(
    `anonymous installation asset ${path}`,
    response.status === 200 &&
      response.headers.get("content-type")?.split(";")[0] === mime &&
      response.headers.get("cache-control") === "no-cache" &&
      response.headers.get("x-content-type-options") === "nosniff" &&
      (path !== "/sw.js" || response.headers.get("service-worker-allowed") === "/"),
    `GET ${path} answered ${response.status}: type=${response.headers.get("content-type")}, cache=${response.headers.get("cache-control")}, nosniff=${response.headers.get("x-content-type-options")}, scope=${response.headers.get("service-worker-allowed")}`,
  );
}

for (const path of ["/assets/pages.css", "/icons/missing.png", "/content/missing"]) {
  const response = await fetch(new URL(path, target.appUrl), { redirect: "manual" });
  check(
    `Access still protects ${path}`,
    response.status === 302 || response.status === 401 || response.status === 403,
    `GET ${path} without a service token answered ${response.status}`,
  );
}
const missingIcon = await fetch(new URL("/icons/missing.png", target.appUrl), {
  headers: { ...accessHeaders(target), "Sec-Fetch-Mode": "navigate" },
  redirect: "manual",
});
check(
  "a missing icon is 404 instead of the web shell",
  missingIcon.status === 404 && !missingIcon.headers.get("content-type")?.startsWith("text/html"),
  `GET /icons/missing.png answered ${missingIcon.status} ${missingIcon.headers.get("content-type")}`,
);

const authServer = await fetch(new URL("/.well-known/oauth-authorization-server", target.appUrl), {
  headers: accessHeaders(target),
  redirect: "manual",
});
const authServerType = authServer.headers.get("content-type") ?? "";
const authServerIssuer =
  authServer.ok && authServerType.includes("application/json")
    ? ((await authServer.json()) as { issuer?: unknown }).issuer
    : undefined;
check(
  "mcp authorization server metadata",
  authServer.status === 200 && typeof authServerIssuer === "string",
  `GET /.well-known/oauth-authorization-server answered ${authServer.status} ${authServerType} with issuer ${String(authServerIssuer)}`,
);

const mcpChallenge = await fetch(new URL("/mcp", target.appUrl), {
  method: "POST",
  headers: { ...accessHeaders(target), "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  redirect: "manual",
});
const challenge = mcpChallenge.headers.get("www-authenticate") ?? "";
check(
  "mcp refuses a call without a bearer",
  mcpChallenge.status === 401 && challenge.includes("resource_metadata"),
  `POST /mcp without a bearer answered ${mcpChallenge.status} with WWW-Authenticate ${JSON.stringify(challenge)}`,
);

const callAgentMcp = async (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; result: Record<string, unknown> | undefined }> => {
  const response = await callMcp(
    new URL("/api/mcp", target.appUrl),
    {
      ...accessHeaders(target),
      ...headers,
    },
    body,
  );
  return { status: response.status, result: response.body?.result };
};

const initialized = await callAgentMcp({
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
check(
  "mcp initializes for the agent token",
  initialized.status === 200 && initialized.result?.serverInfo !== undefined,
  `POST /api/mcp initialize answered ${initialized.status} with result ${JSON.stringify(initialized.result)}`,
);

const mcpTools = await callAgentMcp(
  { id: 2, method: "tools/list" },
  { "mcp-protocol-version": MCP_PROTOCOL_VERSION },
);
const toolNames = Array.isArray(mcpTools.result?.tools)
  ? mcpTools.result.tools.map((tool: { name?: unknown }) => tool.name)
  : [];
check(
  "mcp lists the mailbox tools",
  mcpTools.status === 200 && toolNames.includes("list_mailboxes"),
  `POST /api/mcp tools/list answered ${mcpTools.status} with tools ${JSON.stringify(toolNames)}`,
);

const shell = await fetch(new URL("/calendar", target.appUrl), {
  headers: accessHeaders(target),
  redirect: "manual",
});
const shellType = shell.headers.get("content-type") ?? "";
check(
  "web client shell",
  shell.ok && shellType.startsWith("text/html"),
  `GET /calendar answered ${shell.status} ${shellType}`,
);

const threads = await must(
  "mail list",
  unifiedThreadOperationsListAllThreads({ query: { limit: 25 } }),
);
console.log(`  threads ${threads.items?.length ?? 0}`);
const outbox = await must("outbox list", outboxOperationsListOutboxMessages());
const subjects = new Set(outbox.items.map((item) => item.subject));
const missingDrafts = DRAFTS.filter((draft) => !subjects.has(draft.subject));
check(
  "seeded drafts",
  missingDrafts.length === 0,
  `missing ${missingDrafts.map((d) => d.subject).join(", ")}`,
);

const calendars = await must("calendar list", calendarOperationsListCalendars());
const calendar = calendars.items.find((item) => item.urlSegment === CALENDAR.urlSegment);
if (calendar === undefined) {
  console.error(`calendar ${CALENDAR.urlSegment} is missing; run npm run seed:dev`);
  process.exit(1);
}

const weekStart = iso(started - 7 * DAY_MS);
const weekEnd = iso(started + 7 * DAY_MS);
const week = await must(
  "calendar week",
  calendarEventOperationsListCalendarEvents({
    query: { from: weekStart, to: weekEnd, calendarId: [calendar.calendarId] },
  }),
);
check(
  "calendar renders the weekly fixture",
  week.items.some((item) => item.summary === WEEKLY_SUMMARY),
  `no ${WEEKLY_SUMMARY} between ${weekStart} and ${weekEnd}`,
);

const summary = `Smoke ${process.env.WORKERS_CI_COMMIT_SHA ?? started}`;
const eventStart = Math.floor((started + DAY_MS) / HOUR_MS) * HOUR_MS;
const created = await must(
  "create event",
  calendarEventOperationsCreateCalendarEvent({
    body: {
      calendarId: calendar.calendarId,
      summary,
      start: iso(eventStart),
      end: iso(eventStart + HOUR_MS / 2),
    },
  }),
);
const listed = await must(
  "list created event",
  calendarEventOperationsListCalendarEvents({
    query: {
      from: iso(started),
      to: iso(started + 2 * DAY_MS),
      calendarObjectId: created.calendarObjectId,
    },
  }),
);
check(
  "created event lists",
  listed.items.some((item) => item.summary === summary),
  `${created.calendarObjectId} is not in the listing`,
);
await succeeds(
  "delete event",
  calendarEventDetailOperationsDeleteCalendarEvent({
    path: { calendarObjectId: created.calendarObjectId },
    query: { calendarId: calendar.calendarId, scope: "All" },
  }),
);

console.log(`smoke:dev passed in ${Date.now() - started}ms`);
