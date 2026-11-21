import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { keyChoiceOf } from "../src/classification-key";
import {
  openClassificationKey,
  sealClassificationKey,
  sealsEmptyKey,
} from "../src/crypto/envelope";

const masterKey = randomBytes(32).toString("base64");
const env = { MASTER_KEY: { get: async () => masterKey } };

const MISTRAL = { presetId: "Mistral", baseUrl: "https://api.eu.mistral.ai/v1" };
const input = {
  presetId: "Mistral",
  model: "",
  baseUrl: "",
  apiKey: "",
  dailyLimit: 500,
  enabled: true,
};

describe("classifier key", () => {
  it("opens what it seals, and tells an empty key from a set one", async () => {
    const sealed = await sealClassificationKey(env, "a-classifier-key");
    assert.equal(await openClassificationKey(env, sealed), "a-classifier-key");
    assert.equal(sealsEmptyKey(sealed), false);
    assert.equal(sealsEmptyKey(await sealClassificationKey(env, "")), true);
  });

  it("refuses to open a key sealed under another master key", async () => {
    const sealed = await sealClassificationKey(env, "a-classifier-key");
    const other = { MASTER_KEY: { get: async () => randomBytes(32).toString("base64") } };
    await assert.rejects(openClassificationKey(other, sealed));
  });

  it("keeps the stored key only while the preset and base URL stay", () => {
    assert.equal(keyChoiceOf(MISTRAL, input).kind, "Keep");
    assert.equal(keyChoiceOf(MISTRAL, { ...input, baseUrl: MISTRAL.baseUrl }).kind, "Keep");
    assert.equal(
      keyChoiceOf(MISTRAL, { ...input, baseUrl: "https://classifier.example/v1" }).kind,
      "Refused",
    );
    assert.equal(keyChoiceOf(MISTRAL, { ...input, presetId: "Gemini" }).kind, "Refused");
    assert.deepEqual(
      keyChoiceOf(MISTRAL, { ...input, baseUrl: "https://classifier.example/v1", apiKey: "new" }),
      { kind: "Enter", apiKey: "new" },
    );
  });
});
