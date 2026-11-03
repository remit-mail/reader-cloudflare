import { expect, type Locator, type Page, test } from "@playwright/test";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendRawMessage } from "../.reader/packages/e2e/src/imap.js";
import { waitForAcceptedMessage } from "../.reader/packages/e2e/src/smtp-sink.js";
import {
  type Calendar,
  connectImapAccount,
  connectSendingAccount,
  defaultCalendarId,
  deliverInvitation,
  type EventInstance,
  eraseTenant,
  eventsBetween,
  type ImapAccount,
  invitation,
  type Json,
  mintIdentity,
  pendingSuggestions,
  tenantJson,
  tenantRequest,
} from "./tenant.js";

const IDENTITY = mintIdentity("calendar");
const ZONE = "Europe/Amsterdam";
const json = tenantJson(IDENTITY);

const WEEK = "2027-02-08";
const REPEATING_WEEK = "2027-02-15";
const INVITATION_WEEK = "2027-03-08";
const SERIES_FIRST = "2027-05-03";
const SERIES_DAYS = 150;
const SERIES_MONTH = "2027-06-01";

interface Shared {
  account: ImapAccount;
  calendarId: string;
  createdId: string;
  movedId: string;
}

const shared: Shared = {
  account: { accountId: "", imapUser: "" },
  calendarId: "",
  createdId: "",
  movedId: "",
};

const stamp = Date.now();
const CREATED = `Quick-created ${stamp}`;
const MOVED = `Dragged ${stamp}`;
const REPEATING = `Standup ${stamp}`;
const DAILY = `Daily ${stamp}`;

const instant = (iso: string): number => Date.parse(iso);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const chip = (scope: Page | Locator, title: string): Locator =>
  scope.getByRole("button", { name: new RegExp(`^${escaped(title)}, `) });

const dayColumn = (page: Page, date: string): Locator =>
  page.locator(`[data-time-columns] [data-date="${date}"]`);

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box on screen");
  return box;
};

const eventsIn = (from: string, to: string): Promise<EventInstance[]> =>
  eventsBetween(json, `${from}T00:00:00+01:00`, `${to}T00:00:00+01:00`);

const instancesOf = (events: EventInstance[], summary: string): EventInstance[] =>
  events.filter((event) => event.summary === summary);

const todayIn = (zone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());

const failedApiCalls = (page: Page): string[] => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      failed.push(`${response.status()} ${response.url()}`);
    }
  });
  return failed;
};

const drag = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
};

test.use({
  extraHTTPHeaders: { "x-dev-identity": IDENTITY },
  timezoneId: ZONE,
  viewport: { width: 1440, height: 900 },
});

test.describe.configure({ mode: "serial" });

test.describe("the calendar on a local Worker", () => {
  test.beforeAll(async () => {
    shared.account = await connectImapAccount(json);
    shared.calendarId = await defaultCalendarId(json);
  });

  test.afterAll(() => eraseTenant(json, IDENTITY));

  test("the app bar opens the calendar on this week", async ({ page }) => {
    await page.goto("/mail");
    const apps = page.getByRole("navigation", { name: "Apps" });
    await apps.getByRole("link", { name: "Calendar" }).click();

    await expect(page).toHaveURL(new RegExp(`/calendar/week/${todayIn(ZONE)}$`));
    await expect(page.getByRole("grid", { name: "Time grid" })).toBeVisible();
  });

  test("a range dragged across the grid saves as an event that survives a reload", async ({
    page,
  }) => {
    await page.goto(`/calendar/week/${WEEK}`);
    const column = dayColumn(page, "2027-02-10");
    const box = await boxOf(column);
    const minuteY = (minute: number): number => box.y + (box.height * minute) / (24 * 60);
    const x = box.x + box.width / 2;

    await drag(page, { x, y: minuteY(10 * 60) + 2 }, { x, y: minuteY(11 * 60) - 2 });
    const card = page.getByRole("dialog", { name: "New event" });
    await card.getByLabel("Title").fill(CREATED);
    await card.getByRole("button", { name: "Save", exact: true }).click();

    const [created] = await waitFor(
      async () => instancesOf(await eventsIn(WEEK, "2027-02-15"), CREATED),
      (found) => found.length === 1,
      { what: `"${CREATED}" in the week listing` },
    );
    if (created === undefined) throw new Error("matched but not found");
    expect(instant(created.start)).toBe(instant("2027-02-10T10:00:00+01:00"));
    expect(instant(created.end)).toBe(instant("2027-02-10T11:00:00+01:00"));
    const stored = await json<{ icalData: string }>(
      "GET",
      `/calendar-events/${created.calendarObjectId}?calendarId=${created.calendarId}`,
    );
    expect(stored.icalData).toContain(`DTSTART;TZID=${ZONE}:20270210T100000`);
    expect(stored.icalData).toContain(`DTEND;TZID=${ZONE}:20270210T110000`);
    shared.createdId = created.calendarObjectId;

    await page.reload();
    await expect(chip(dayColumn(page, "2027-02-10"), CREATED)).toBeVisible();
  });

  test("a reload of an event's address reopens its popup", async ({ page }) => {
    await page.goto(`/calendar/week/${WEEK}/${shared.createdId}`);
    await page.reload();

    await expect(page.getByRole("dialog").getByRole("heading", { name: CREATED })).toBeVisible();
  });

  test("dragging a one-off event to another day moves it on the server", async ({ page }) => {
    const { calendarObjectId } = await json<{ calendarObjectId: string }>(
      "POST",
      "/calendar-events",
      {
        calendarId: shared.calendarId,
        summary: MOVED,
        start: "2027-02-09T14:00:00+01:00",
        end: "2027-02-09T15:00:00+01:00",
        timeZone: ZONE,
      },
    );
    shared.movedId = calendarObjectId;
    await page.goto(`/calendar/week/${WEEK}`);
    const from = await boxOf(chip(dayColumn(page, "2027-02-09"), MOVED));
    const target = await boxOf(dayColumn(page, "2027-02-11"));
    const y = from.y + from.height / 2;

    await drag(page, { x: from.x + from.width / 2, y }, { x: target.x + target.width / 2, y });

    const [moved] = await waitFor(
      async () => instancesOf(await eventsIn(WEEK, "2027-02-15"), MOVED),
      (found) =>
        found.length === 1 &&
        instant(found[0]?.start ?? "") !== instant("2027-02-09T14:00:00+01:00"),
      { what: `"${MOVED}" moved in the week listing` },
    );
    expect(instant(moved?.start ?? "")).toBe(instant("2027-02-11T14:00:00+01:00"));
    expect(instant(moved?.end ?? "")).toBe(instant("2027-02-11T15:00:00+01:00"));
    await page.reload();
    await expect(chip(dayColumn(page, "2027-02-11"), MOVED)).toBeVisible();
  });

  test("moving one occurrence of a series changes that occurrence only", async ({ page }) => {
    const { calendarObjectId, calendarId } = await json<{
      calendarObjectId: string;
      calendarId: string;
    }>("POST", "/calendar-events", {
      calendarId: shared.calendarId,
      summary: REPEATING,
      start: "2027-02-15T09:00:00+01:00",
      end: "2027-02-15T10:00:00+01:00",
      timeZone: ZONE,
      recurrenceRule: "FREQ=DAILY;COUNT=5",
    });
    await page.goto(`/calendar/week/${REPEATING_WEEK}`);
    const column = await boxOf(dayColumn(page, "2027-02-17"));
    const from = await boxOf(chip(dayColumn(page, "2027-02-17"), REPEATING));
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    const twoHours = (column.height * 2) / 24;

    await drag(page, { x, y }, { x, y: y + twoHours });
    await page
      .getByRole("dialog", { name: "Move a repeating event" })
      .getByRole("button", { name: /^This event/ })
      .click();

    const series = await waitFor(
      async () => instancesOf(await eventsIn(REPEATING_WEEK, "2027-02-22"), REPEATING),
      (found) =>
        found.some((event) => instant(event.start) === instant("2027-02-17T11:00:00+01:00")),
      { what: `the moved occurrence of "${REPEATING}"` },
    );
    expect(series.map((event) => instant(event.start)).sort()).toEqual(
      [
        "2027-02-15T09:00:00+01:00",
        "2027-02-16T09:00:00+01:00",
        "2027-02-17T11:00:00+01:00",
        "2027-02-18T09:00:00+01:00",
        "2027-02-19T09:00:00+01:00",
      ].map(instant),
    );
    const stored = await json<{ icalData: string }>(
      "GET",
      `/calendar-events/${calendarObjectId}?calendarId=${calendarId}`,
    );
    expect(stored.icalData).toContain("RRULE:FREQ=DAILY;COUNT=5");
    await page.reload();
    await expect(chip(dayColumn(page, "2027-02-17"), REPEATING)).toBeVisible();
    await expect(chip(page.locator("[data-time-columns]"), REPEATING)).toHaveCount(5);
  });

  test("a daily series draws every instance in month and year view with no server error", async ({
    page,
  }) => {
    await json("POST", "/calendar-events", {
      calendarId: shared.calendarId,
      summary: DAILY,
      start: `${SERIES_FIRST}T07:00:00+02:00`,
      end: `${SERIES_FIRST}T07:30:00+02:00`,
      timeZone: ZONE,
      recurrenceRule: `FREQ=DAILY;COUNT=${SERIES_DAYS}`,
    });
    const failed = failedApiCalls(page);

    await page.goto(`/calendar/month/${SERIES_MONTH}`);
    const grid = page.getByTestId("calendar-grid");
    await expect(async () => {
      const ids = await grid
        .locator("[data-event-id]")
        .evaluateAll((elements) => [
          ...new Set(elements.map((element) => element.getAttribute("data-event-id"))),
        ]);
      // June 2027 drawn Monday first: Mon 31 May to Sun 4 July.
      expect(ids).toHaveLength(35);
    }).toPass({ timeout: 30_000 });

    await page.goto(`/calendar/year/${SERIES_MONTH}`);
    await expect(async () => {
      const busy = await page
        .locator("[data-calendar-year] button[data-date]")
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => button.getAttribute("aria-label")?.endsWith(", 1 event"))
            .map((button) => button.getAttribute("data-date") ?? ""),
        );
      const days = new Set(busy.filter((date) => date >= SERIES_FIRST && date <= "2027-09-29"));
      expect(days.size).toBe(SERIES_DAYS);
    }).toPass({ timeout: 30_000 });
    expect(failed).toEqual([]);
  });

  test("deleting an event takes it off the grid and its address says so", async ({ page }) => {
    await page.goto(`/calendar/week/${WEEK}`);
    await chip(dayColumn(page, "2027-02-11"), MOVED).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();

    await expect(chip(page.locator("[data-time-columns]"), MOVED)).toHaveCount(0);
    await waitFor(
      async () => instancesOf(await eventsIn(WEEK, "2027-02-15"), MOVED),
      (found) => found.length === 0,
      { what: `"${MOVED}" gone from the week listing` },
    );
    await page.goto(`/calendar/week/${WEEK}/${shared.movedId}`);
    await page.reload();
    await expect(page.getByText("This event was deleted or moved")).toBeVisible();
  });

  test("an invitation in the mail is added to the calendar from the sidebar", async ({ page }) => {
    const invite = invitation("calendar", "2027-03-10T13:00:00Z", "2027-03-10T14:00:00Z");
    await deliverInvitation(json, shared.account, invite);

    await page.goto(`/calendar/week/${INVITATION_WEEK}`);
    const waiting = page.getByRole("complementary", { name: "Waiting for you" });
    await waiting
      .getByRole("article", { name: invite.summary })
      .getByRole("button", { name: "Change first" })
      .click();
    await page
      .getByRole("form", { name: "Add from mail" })
      .getByRole("button", { name: "Add", exact: true })
      .click();

    const [added] = await waitFor(
      async () => instancesOf(await eventsIn(INVITATION_WEEK, "2027-03-15"), invite.summary),
      (found) => found.length === 1,
      { what: `"${invite.summary}" on the calendar` },
    );
    expect(added?.calendarId).toBe(shared.calendarId);
    expect(instant(added?.start ?? "")).toBe(instant(invite.start));
    expect((await pendingSuggestions(json)).map((pending) => pending.summary)).not.toContain(
      invite.summary,
    );
    await expect(chip(dayColumn(page, "2027-03-10"), invite.summary)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Waiting for you" })).toHaveCount(0);
  });
});

const ORGANIZER = mintIdentity("organizer");
const GUEST = mintIdentity("guest");
const organizerJson = tenantJson(ORGANIZER);
const guestJson = tenantJson(GUEST);
const GUESTS_SUMMARY = `Guests ${stamp}`;
const GUESTS_FROM = "2027-04-13T00:00:00+00:00";
const GUESTS_TO = "2027-04-16T00:00:00+00:00";
const TASK_WEEK = { from: "2027-05-03T00:00:00+00:00", to: "2027-05-10T00:00:00+00:00" };
const WEEK_AFTER = { from: "2027-05-10T00:00:00+00:00", to: "2027-05-17T00:00:00+00:00" };

interface Send {
  readonly email: string;
  readonly method: string;
}

interface Attendee {
  readonly email: string;
  readonly status: string;
}

interface EventResource {
  readonly calendarId: string;
  readonly calendarObjectId: string;
  readonly participation: string;
  readonly attendees: Attendee[];
  readonly sends: Send[];
}

interface ListedEvent extends EventInstance {
  readonly participation: string;
}

interface Task {
  readonly calendarId: string;
  readonly calendarTaskId: string;
  readonly completed: boolean;
}

interface Settings {
  readonly defaultInvitationSenderAccountId: string;
  readonly defaultInvitationSenderChosen: boolean;
}

interface Guests {
  organizer: ImapAccount;
  guest: ImapAccount;
  event: EventResource | null;
}

const guests: Guests = {
  organizer: { accountId: "", imapUser: "" },
  guest: { accountId: "", imapUser: "" },
  event: null,
};

const invitedEvent = (): EventResource => {
  if (guests.event === null) throw new Error("no event was created with a guest");
  return guests.event;
};

const calendarPart = (raw: string): string =>
  raw.replace(/\r?\n[ \t]+/g, " ").match(/Content-Type: text\/calendar;[^\r\n]*/i)?.[0] ?? "";

// What the recipient's provider does with an accepted submission: file it in their inbox.
const deliverTo = async (raw: string, json: Json, account: ImapAccount): Promise<void> => {
  await appendRawMessage(account.imapUser, raw);
  await json("POST", `/accounts/${account.accountId}/sync`);
};

const listedEvents = (json: Json): Promise<ListedEvent[]> =>
  json<{ items?: ListedEvent[] }>(
    "GET",
    `/calendar-events?${new URLSearchParams({ from: GUESTS_FROM, to: GUESTS_TO })}`,
  ).then((page) => (page.items ?? []).filter((item) => item.summary === GUESTS_SUMMARY));

const tasksIn = ({ from, to }: { from: string; to: string }): Promise<Task[]> =>
  organizerJson<{ items: Task[] }>(
    "GET",
    `/calendar-tasks?${new URLSearchParams({ from, to })}`,
  ).then((page) => page.items);

test.describe("guests and tasks on a local Worker", () => {
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    guests.organizer = await connectSendingAccount(organizerJson);
    guests.guest = await connectSendingAccount(guestJson);
  });

  test.afterAll(async () => {
    await eraseTenant(organizerJson, ORGANIZER);
    await eraseTenant(guestJson, GUEST);
  });

  test("settings read and patch the default invitation sender", async () => {
    const { accountId } = guests.organizer;
    expect(await organizerJson<Settings>("GET", "/settings")).toEqual({
      defaultInvitationSenderAccountId: accountId,
      defaultInvitationSenderChosen: false,
    });

    const patched = await organizerJson<Settings>("PATCH", "/settings", {
      defaultInvitationSenderAccountId: accountId,
    });
    expect(patched).toEqual({
      defaultInvitationSenderAccountId: accountId,
      defaultInvitationSenderChosen: true,
    });
    expect(await organizerJson<Settings>("GET", "/settings")).toEqual(patched);
  });

  test("an event saved with a guest sends them an invitation", async () => {
    const event = await organizerJson<EventResource>("POST", "/calendar-events", {
      calendarId: await defaultCalendarId(organizerJson),
      summary: GUESTS_SUMMARY,
      start: "2027-04-14T09:00:00+00:00",
      end: "2027-04-14T10:00:00+00:00",
      attendees: [{ email: guests.guest.imapUser, displayName: "The Guest" }],
      organizerAccountId: guests.organizer.accountId,
    });
    expect(event.participation).toBe("Organizer");
    expect(event.sends).toEqual([
      expect.objectContaining({ email: guests.guest.imapUser, method: "Request" }),
    ]);
    guests.event = event;

    const invitation = await waitForAcceptedMessage(`Invitation: ${GUESTS_SUMMARY}`, {
      timeoutMs: 60_000,
    });
    expect(calendarPart(invitation.raw)).toMatch(/method=REQUEST/i);
    await deliverTo(invitation.raw, guestJson, guests.guest);
  });

  test("the guest answers and the organizer sees the answer", async () => {
    const pending = await waitFor(
      () => pendingSuggestions(guestJson),
      (items) => items.some((item) => item.summary === GUESTS_SUMMARY),
      { timeoutMs: 120_000, what: `the invitation to "${GUESTS_SUMMARY}" at the guest` },
    );
    const card = pending.find((item) => item.summary === GUESTS_SUMMARY);
    if (card === undefined) throw new Error("matched but not found");
    await guestJson("POST", `/calendar-suggestions/${card.suggestionId}/accept`, {
      calendarId: await defaultCalendarId(guestJson),
      answer: "Accepted",
    });
    const [accepted] = await listedEvents(guestJson);
    if (accepted === undefined) throw new Error("the accepted invitation is not on the calendar");
    expect(accepted.participation).toBe("Accepted");

    const declined = await guestJson<EventResource>(
      "PATCH",
      `/calendar-events/${accepted.calendarObjectId}?calendarId=${accepted.calendarId}`,
      { answer: "Declined" },
    );
    expect(declined.participation).toBe("Declined");
    expect(declined.sends).toEqual([
      expect.objectContaining({ email: guests.organizer.imapUser, method: "Reply" }),
    ]);
    expect((await listedEvents(guestJson)).map((item) => item.participation)).toEqual(["Declined"]);

    const reply = await waitForAcceptedMessage(`Declined: ${GUESTS_SUMMARY}`, {
      timeoutMs: 60_000,
    });
    expect(calendarPart(reply.raw)).toMatch(/method=REPLY/i);
    await deliverTo(reply.raw, organizerJson, guests.organizer);

    const { calendarObjectId, calendarId } = invitedEvent();
    await waitFor(
      () =>
        organizerJson<EventResource>(
          "GET",
          `/calendar-events/${calendarObjectId}?calendarId=${calendarId}`,
        ),
      (resource) =>
        resource.attendees.some(
          (attendee) => attendee.email === guests.guest.imapUser && attendee.status === "Declined",
        ),
      { timeoutMs: 120_000, what: "the guest's answer on the organizer's copy" },
    );
  });

  test("deleting an event with a guest sends them a cancellation", async () => {
    const { calendarObjectId, calendarId } = invitedEvent();
    const response = await tenantRequest(ORGANIZER)(
      "DELETE",
      `/calendar-events/${calendarObjectId}?${new URLSearchParams({ calendarId, scope: "All" })}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sends: [expect.objectContaining({ email: guests.guest.imapUser, method: "Cancel" })],
    });

    const cancellation = await waitForAcceptedMessage(`Cancelled: ${GUESTS_SUMMARY}`, {
      timeoutMs: 60_000,
    });
    expect(calendarPart(cancellation.raw)).toMatch(/method=CANCEL/i);
  });

  test("a task round-trips through the task list", async () => {
    const { items } = await organizerJson<{ items: Calendar[] }>("GET", "/calendars");
    const lists = items.filter((collection) => collection.componentSet === "VtodoOnly");
    expect(lists).toHaveLength(1);

    const created = await organizerJson<Task>("POST", "/calendar-tasks", {
      summary: `Task ${stamp}`,
      due: "2027-05-05",
      allDay: true,
    });
    expect(created.calendarId).toBe(lists[0]?.calendarId);
    expect(created.completed).toBe(false);

    const taskPath = `/calendar-tasks/${created.calendarTaskId}?calendarId=${created.calendarId}`;
    const done = await organizerJson<Task>("PATCH", taskPath, { completed: true });
    expect(done.completed).toBe(true);
    expect(await tasksIn(TASK_WEEK)).toContainEqual(
      expect.objectContaining({ calendarTaskId: created.calendarTaskId, completed: true }),
    );
    expect(await tasksIn(WEEK_AFTER)).toEqual([]);

    const removed = await tenantRequest(ORGANIZER)("DELETE", taskPath);
    expect(removed.status).toBe(204);
    expect((await tasksIn(TASK_WEEK)).map((task) => task.calendarTaskId)).not.toContain(
      created.calendarTaskId,
    );
  });
});
