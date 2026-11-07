import { describe, expect, it } from "vitest";
import { call, createUser, testEnv, uniqueEmail } from "./helpers";

const refusingEnv = {
  ...testEnv,
  EMAIL: {
    send: async () => {
      throw new Error("sender not verified");
    },
  } as unknown as SendEmail,
};

describe("reset request", () => {
  it("answers the same for a known, an unknown and a refused address", async () => {
    const known = uniqueEmail("known");
    await createUser(known);
    const answers = await Promise.all([
      call("/app/reset/request", { body: { email: known } }),
      call("/app/reset/request", { body: { email: uniqueEmail("unknown") } }),
      call("/app/reset/request", { body: { email: known }, env: refusingEnv }),
    ]);
    const shapes = await Promise.all(
      answers.map(async (answer) => `${answer.status} ${await answer.text()}`),
    );
    expect(new Set(shapes).size).toBe(1);
    expect(answers[0]?.status).toBe(202);
  });
});
