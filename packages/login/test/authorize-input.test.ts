import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("authorization input errors", () => {
  it.each([
    ["", "client_id parameter is missing"],
    ["?client_id=unknown", "client_id parameter does not identify"],
    ["?client_id=reader-cloudflare-access", "redirect_uri parameter is missing"],
  ])("names the invalid input in %s", async (query, message) => {
    const response = await call(`/api/auth/oauth2/authorize${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });
});
