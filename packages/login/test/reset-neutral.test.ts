import { describe, expect, it } from "vitest";
import { issueInvite, revokeInvite } from "../src/routes/app";
import { issueResetLink } from "../src/routes/reset";
import { call, createUser, PASSWORD, testEnv, uniqueEmail } from "./helpers";

const refusingEnv = {
  ...testEnv,
  EMAIL: {
    send: async () => {
      throw new Error("sender not verified");
    },
  } as unknown as SendEmail,
};

const shapes = (answers: Response[]): Promise<string[]> =>
  Promise.all(answers.map(async (answer) => `${answer.status} ${await answer.text()}`));

describe("reset request", () => {
  it("answers the same for a known, an unknown and a refused address", async () => {
    const known = uniqueEmail("known");
    await createUser(known);
    const answers = await Promise.all([
      call("/app/reset/request", { body: { email: known } }),
      call("/app/reset/request", { body: { email: uniqueEmail("unknown") } }),
      call("/app/reset/request", { body: { email: known }, env: refusingEnv }),
    ]);
    expect(new Set(await shapes(answers)).size).toBe(1);
    expect(answers[0]?.status).toBe(202);
  });
});

describe("fresh link request", () => {
  it("answers the same for every token", async () => {
    const invited = uniqueEmail("invited");
    const live = await issueInvite(testEnv.DB, invited, "test");
    const revokedEmail = uniqueEmail("revoked");
    const revoked = await issueInvite(testEnv.DB, revokedEmail, "test");
    await revokeInvite(testEnv.DB, revoked.inviteId);
    const user = await createUser(uniqueEmail("member"), { password: PASSWORD });
    const reset = await issueResetLink(testEnv.DB, user, Date.now());
    const bodies = [
      { token: live.token },
      { token: revoked.token },
      { token: reset },
      { token: "an-unknown-token" },
      {},
    ];
    const answers = await Promise.all(bodies.map((body) => call("/app/link/fresh", { body })));
    expect(new Set(await shapes(answers)).size).toBe(1);
    expect(answers[0]?.status).toBe(202);
  });
});
