import { describe, expect, it } from "vitest";
import { refusalOf } from "../web/src/refusal";
import { passwordProblem, signInNotice } from "../web/src/sign-in-problem";

const noticeFor = (status: number, body: unknown) =>
  signInNotice(passwordProblem(refusalOf(status, body)));

describe("sign-in page messages", () => {
  it("reads a wrong password as a wrong password", () => {
    expect(
      noticeFor(401, { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" }),
    ).toEqual({
      tone: "danger",
      title: "Wrong email or password",
      body: "Check both and try again. Forgot it?",
      action: "reset",
    });
  });

  it("says an expired sign-in page expired and offers a fresh one", () => {
    expect(noticeFor(400, { error: "invalid_signature" })).toEqual({
      tone: "warning",
      title: "This sign-in page expired",
      body: "A sign-in page works for 10 minutes. Your password was not checked. Start again and sign in on the fresh page.",
      action: "restart",
    });
  });

  it("says sign-in is paused and until when", () => {
    const notice = noticeFor(429, {
      message: "Too many attempts. Try again later.",
      code: "BACKOFF",
      retryAt: "2026-11-21T14:38:33.725Z",
    });
    expect(notice?.title).toBe("Sign-in is paused");
    expect(notice?.body).toMatch(
      /^Too many attempts\. Try again later\. Try again after .+\. Forgot your password\? Reset it with a link by email\.$/,
    );
  });

  it("says a disabled account is disabled", () => {
    expect(noticeFor(403, { message: "You have been banned", code: "BANNED_USER" })).toEqual({
      tone: "danger",
      title: "This account is disabled",
      body: "Ask the person who invited you.",
    });
  });

  it("names a server failure as ours and says to retry or report", () => {
    expect(noticeFor(500, {})).toEqual({
      tone: "danger",
      title: "Sign-in failed on our side",
      body: "The login site refused the request (HTTP 500) without saying why. This is not your fault. Try again in a minute. If it keeps failing, report it.",
      report: "The login site refused the request (HTTP 500) without saying why.",
    });
  });

  it("names the cause of a refusal from an OAuth error description", () => {
    expect(
      noticeFor(400, { error: "invalid_request", error_description: "redirect_uri mismatch" }),
    ).toEqual({
      tone: "danger",
      title: "The login site refused the sign-in",
      body: "redirect_uri mismatch. Try again. If it keeps failing, report it.",
      report: "redirect_uri mismatch.",
    });
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
