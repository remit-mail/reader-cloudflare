import { configOperationsGetConfig } from "@remit/api-http-client/sdk.gen.ts";

const deployedCommit = async (): Promise<string> => {
  const { data } = await configOperationsGetConfig({ throwOnError: true, cache: "no-store" });
  return data.buildCommit;
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
