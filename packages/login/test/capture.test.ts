import { describe, expect, it } from "vitest";
import { latestCapturedMail, mailerOf } from "../src/capture";
import { configOf } from "../src/config";
import { sendInvite } from "../src/mail";
import { ORIGIN, testEnv, uniqueEmail } from "./helpers";

const capturingEnv = {
  ...testEnv,
  MAIL_CAPTURE: "on",
  EMAIL: {
    send: async () => {
      throw new Error("a capturing stage must never send");
    },
  } as unknown as SendEmail,
};

describe("mail capture", () => {
  it("stores an invite instead of sending it and reads it back with its link", async () => {
    const to = uniqueEmail("captured");
    const outcome = await sendInvite(mailerOf(capturingEnv), configOf(capturingEnv), to, "tok");
    expect(outcome).toEqual({ ok: true });
    const latest = await latestCapturedMail(capturingEnv.DB, Date.now());
    const mail = latest.find((captured) => captured.recipient === to);
    expect(mail?.subject).toBe("You are invited to remit");
    expect(mail?.body).toContain(`${ORIGIN}/invite#tok`);
  });

  it("sends through the binding when capture is off", () => {
    expect(mailerOf(testEnv)).toBe(testEnv.EMAIL);
    const { EMAIL: _email, ...unbound } = testEnv;
    expect(() => mailerOf(unbound)).toThrow(/no EMAIL binding/);
  });
});
