const VERSION_URL = "/api/version";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const commitOf = (body: unknown): string => {
  if (isRecord(body) && typeof body.commit === "string") return body.commit;
  throw new Error(`GET ${VERSION_URL} answered without a commit`);
};

const deployedCommit = async (): Promise<string> => {
  const response = await fetch(VERSION_URL, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${VERSION_URL} returned ${response.status}`);
  return commitOf(await response.json());
};

const reloadWhenSuperseded = async (): Promise<void> => {
  if ((await deployedCommit()) === __APP_SHA__) return;
  window.location.reload();
};

export const reloadOnStaleChunks = (): void => {
  window.addEventListener("vite:preloadError", () => {
    void reloadWhenSuperseded();
  });
};
