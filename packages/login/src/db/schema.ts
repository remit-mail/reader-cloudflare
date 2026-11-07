import * as loginSchema from "login-db-schema";
import * as authSchema from "./auth-schema";

export * from "login-db-schema";
export * from "./auth-schema";

export const schema = { ...authSchema, ...loginSchema };
