import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth";

export const auth = betterAuth(
  authOptions(
    {
      config: {
        loginOrigin: "https://login.example.com",
        loginHostname: "login.example.com",
        readerOrigin: "https://reader.example.com",
        clientId: "schema",
        sender: "login@example.com",
        operatorEmails: new Set(),
      },
      db: {} as D1Database,
      email: {} as SendEmail,
      secret: "schema-generation-only-secret-value",
      waitUntil: () => {},
    },
    [],
  ),
);
