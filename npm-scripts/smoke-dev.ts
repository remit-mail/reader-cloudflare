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
