import type { PeopleDirectory } from "@remit/auth-service/people";
import type { Env } from "./env";

export const hostedPeopleDirectory = (env: Env): PeopleDirectory => env.PEOPLE_DIRECTORY;
