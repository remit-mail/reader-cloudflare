import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLESHEET_PATH } from "@remit/mcp-server/app";

const PAGE_ASSET_EXTENSIONS = new Set([".css", ".woff2"]);

const source = dirname(fileURLToPath(import.meta.resolve("@remit/mcp-server/pages.css")));
const target = join(import.meta.dirname, "..", "packages", "web", "dist", dirname(STYLESHEET_PATH));

mkdirSync(target, { recursive: true });
const copied = readdirSync(source).filter((name) => PAGE_ASSET_EXTENSIONS.has(extname(name)));
for (const name of copied) copyFileSync(join(source, name), join(target, name));
console.log(`copied ${copied.length} MCP page assets into ${target}`);
