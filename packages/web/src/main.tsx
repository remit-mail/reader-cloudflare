import { mountApp } from "@remit/web-client/shell";
import { accessAuthProvider } from "./access-auth";

mountApp({ authProvider: accessAuthProvider });
