import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./drizzle.mail.schema.ts",
  out: "./migrations/mail",
});
