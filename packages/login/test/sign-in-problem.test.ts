import { describe, expect, it } from "vitest";
import { refusalOf } from "../web/src/refusal";
import { passwordProblem, signInNotice } from "../web/src/sign-in-problem";

const kindFor = (status: number, body: unknown): string =>
  passwordProblem(refusalOf(status, body)).kind;

const noticeFor = (status: number, body: unknown) =>
  signInNotice(passwordProblem(refusalOf(status, body)));

describe("sign-in page messages", () => {
  it("reads a wrong password as a wrong password", () => {
    expect(
      kindFor(401, { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" }),
    ).toBe("wrong");
  });

  it("reads an expired sign-in page as expired", () => {
    expect(kindFor(400, { error: "invalid_signature" })).toBe("link-expired");
  });

  it("reads a backoff as locked", () => {
    expect(kindFor(429, { message: "Too many attempts.", code: "BACKOFF" })).toBe("locked");
  });

  it("reads a banned user as disabled", () => {
    expect(kindFor(403, { message: "You have been banned", code: "BANNED_USER" })).toBe("disabled");
  });

  it("reads a 500 as a server failure", () => {
    expect(kindFor(500, {})).toBe("server");
  });

  it("names the cause of a refusal sent as plain text", () => {
    expect(
      noticeFor(403, "This request came from a page the login site does not serve.")?.body,
    ).toBe(
      "This request came from a page the login site does not serve. Try again. If it keeps failing, report it.",
    );
  });

  it("never shows a bare status for a refusal without a reason", () => {
    expect(noticeFor(400, {})?.body).toBe(
      "The login site refused the request (HTTP 400) without saying why. Try again. If it keeps failing, report it.",
    );
  });
});
