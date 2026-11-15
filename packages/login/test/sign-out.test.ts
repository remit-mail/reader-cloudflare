import { describe, expect, it } from "vitest";
import { call, createUser, ORIGIN, signIn, testEnv, uniqueEmail } from "./helpers";

const READER_ORIGIN = testEnv.READER_ORIGIN;

const sessionCount = async (sessionId: string): Promise<number> =>
  (
    await testEnv.DB.prepare("SELECT count(*) AS n FROM session WHERE id = ?")
      .bind(sessionId)
      .first<{ n: number }>()
  )?.n ?? 0;

const postForm = (cookie: string, origin: string) =>
  call("/app/sign-out", {
    method: "POST",
    cookie,
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
  });

describe("sign-out form", () => {
  it("serves the page so the browser sends its origin and may follow the logout redirect", async () => {
    const page = await call("/sign-out");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain(
      `form-action 'self' ${READER_ORIGIN};`,
    );
  });

  it("signs out a form post from the login origin", async () => {
    const user = await createUser(uniqueEmail("sign-out"));
    const { cookie, sessionId } = await signIn(user.id);
    const answer = await postForm(cookie, ORIGIN);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`${READER_ORIGIN}/cdn-cgi/access/logout`);
    expect(await sessionCount(sessionId)).toBe(0);
  });

  it.each(["null", "https://attacker.test"])("refuses a post from origin %s", async (origin) => {
    const user = await createUser(uniqueEmail("sign-out-refused"));
    const { cookie, sessionId } = await signIn(user.id);
    const answer = await postForm(cookie, origin);
    expect(answer.status).toBe(403);
    expect(await sessionCount(sessionId)).toBe(1);
  });
});
