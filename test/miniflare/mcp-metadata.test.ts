import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://example.test";
const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const SERVER_METADATA = `${ORIGIN}/.well-known/oauth-authorization-server`;
const ROUNDS = 10;

const metadataStatus = async (url: string): Promise<string> => {
  const response = await SELF.fetch(url);
  const body = await response.text();
  return response.status === 200 ? "200" : `${response.status} ${body}`;
};

describe("MCP OAuth metadata", () => {
  it("serves the server metadata after a protected-resource request", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      expect(await metadataStatus(RESOURCE_METADATA)).toBe("200");
      expect(await metadataStatus(SERVER_METADATA)).toBe("200");
    }
  });

  it("serves both documents to concurrent pairs", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const statuses = await Promise.all(
        [RESOURCE_METADATA, SERVER_METADATA, RESOURCE_METADATA, SERVER_METADATA].map(
          metadataStatus,
        ),
      );
      expect(statuses).toEqual(["200", "200", "200", "200"]);
    }
  });
});
