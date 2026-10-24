import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider } from "./access-auth";
import { reloadOnStaleChunks } from "./stale-build";

reloadOnStaleChunks();
mountApp({ authProvider: accessAuthProvider });
