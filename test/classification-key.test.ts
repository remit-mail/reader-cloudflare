import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { classificationDefaultSnapshot } from "../src/classification-default";
import { openClassificationKey, sealClassificationKey } from "../src/crypto/envelope";

const masterKey = randomBytes(32).toString("base64");
const env = { MASTER_KEY: { get: async () => masterKey } };

describe("classifier key", () => {
  it("opens what it seals", async () => {
    const sealed = await sealClassificationKey(env, "a-classifier-key");
    assert.equal(await openClassificationKey(env, sealed), "a-classifier-key");
  });
});

describe("classifier default snapshot", () => {
  const override = { state: "Configured", presetId: "Mistral" } as const;
  const deployment = { state: "Configured", presetId: "Gemini" } as const;

  it("uses the row before the deployment default, then None", async () => {
    assert.equal(
      await classificationDefaultSnapshot(
        async () => override,
        async () => deployment,
      )(),
      override,
    );
    assert.equal(
      await classificationDefaultSnapshot(
        async () => undefined,
        async () => deployment,
      )(),
      deployment,
    );
    assert.deepEqual(
      await classificationDefaultSnapshot(
        async () => undefined,
        async () => ({ state: "None" }),
      )(),
      { state: "None" },
    );
  });

  it("keeps the last value when the D1 refresh fails", async () => {
    let at = 0;
    let fail = false;
    const read = classificationDefaultSnapshot(
      async () => {
        if (fail) throw new Error("D1 unavailable");
        return override;
      },
      async () => deployment,
      () => at,
    );
    assert.equal(await read(), override);
    fail = true;
    at = 60_000;
    assert.equal(await read(), override);
  });
});
