import { wrangler } from "./cf.mjs";

process.exit(wrangler(process.argv.slice(2)));
