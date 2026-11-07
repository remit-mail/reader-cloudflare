import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_LOGIN_BASE_URL;
if (baseURL === undefined)
  throw new Error("E2E_LOGIN_BASE_URL is not set; run `npm run e2e:login`");

export default defineConfig({
  testDir: "./login",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 180_000,
  outputDir: "../.tmp/e2e-login-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
