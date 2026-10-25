import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./node_modules/@remit/drizzle-service/src/schema-sets/mail.ts",
  out: "./migrations/mail",
});
