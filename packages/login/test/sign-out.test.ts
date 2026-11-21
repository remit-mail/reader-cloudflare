import { afterEach, describe, expect, it, vi } from "vitest";
import {
  call,
  createUser,
  mockPwnedPasswords,
  PASSWORD,
  signIn,
  testEnv,
  uniqueEmail,
  welcome,
} from "./helpers";

const LOGOUT = `${testEnv.READER_ORIGIN}/cdn-cgi/access/logout?${new URLSearchParams({ returnTo: `${testEnv.READER_ORIGIN}/` })}`;

const count = async (where: string, value: string): Promise<number> =>
  (
    await testEnv.DB.prepare(`SELECT count(*) AS n FROM session WHERE ${where} = ?`)
      .bind(value)
      .first<{ n: number }>()
  )?.n ?? 0;

const sessionsOf = async (email: string): Promise<number> => {
  const user = await testEnv.DB.prepare("SELECT id FROM user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (user === null) throw new Error(`no user ${email}`);
  return count("user_id", user.id);
};

describe("GET /sign-out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the session and redirects to the Access logout", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("sign-out");
    const cookie = await welcome(email, PASSWORD);
    const answer = await call("/sign-out", { cookie });
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(LOGOUT);
    expect(answer.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^better-auth\.session_token=;.*Max-Age=0/),
    );
    expect(await sessionsOf(email)).toBe(0);
  });

  it("redirects to the Access logout without a login session", async () => {
    const answer = await call("/sign-out");
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(LOGOUT);
  });
});

describe("/app/sign-out-everywhere", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the session and names the Access logout", async () => {
    mockPwnedPasswords([]);
    const email = uniqueEmail("sign-out-everywhere");
    const cookie = await welcome(email, PASSWORD);
    const answer = await call("/app/sign-out-everywhere", { cookie, body: {} });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ url: LOGOUT });
    expect(answer.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^better-auth\.session_token=;.*Max-Age=0/),
    );
    expect(await sessionsOf(email)).toBe(0);
  });

  it.each(["null", "https://attacker.test"])("refuses a post from origin %s", async (origin) => {
    const user = await createUser(uniqueEmail("sign-out-refused"));
    const { cookie, sessionId } = await signIn(user.id);
    const answer = await call("/app/sign-out-everywhere", {
      cookie,
      body: {},
      headers: { origin },
    });
    expect(answer.status).toBe(403);
    expect(await count("id", sessionId)).toBe(1);
  });
});
