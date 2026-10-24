# reader-cloudflare

remit reader on Cloudflare Workers. A TypeScript Worker in `src/`, configured by `wrangler.jsonc`, serving the React web client in `packages/web` as assets; OpenTofu in `infra/` for the Cloudflare account.

## Rules

- TypeScript only. No Python.
- npm workspaces with one lockfile at the root. Current major versions of every tool; Node 24 (`.nvmrc`).
- Biome formats and lints. Run `npm run fix` before every commit.
- Run `npm run ci` before every push.
- Push straight to `main` until the prototype runs end to end.
- CI is one fast job: `npm ci`, `npm run check`, `npm run typecheck`.
- The Worker logs one JSON object per line through `log` in `src/log.ts`. Workers Observability is on in `wrangler.jsonc`.
- `npm run commit` writes the gitignored `src/commit.ts` from `WORKERS_CI_COMMIT_SHA`, else `git rev-parse HEAD`. `wrangler.jsonc` runs it and then `npm run build` as the build command, so `dev` and `deploy` ship fresh assets; `typecheck` runs it first. The Worker answers `/api/version` with `{ commit }` and an `x-reader-commit` header, so a deploy matches a commit.

## Scripts

| Script                               | Does                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `npm run dev`                        | `wrangler dev` on port 8790, bound to `0.0.0.0`                                           |
| `npm run deploy -- --bootstrap`      | `wrangler deploy` from this machine, before Workers Builds runs; refuses without the flag |
| `npm run build`                      | Vite builds the web client into `packages/web/dist`                                       |
| `npm run tail`                       | `wrangler tail --format pretty` on the deployed Worker                                    |
| `npm run commit`                     | Write `src/commit.ts` with the commit sha baked into the Worker                           |
| `npm run fix`                        | Biome rewrites files                                                                      |
| `npm run check`                      | Biome format and lint check                                                               |
| `npm run typecheck`                  | `tsc` over `src` and every package, against declarations `build:vendor-types` emits       |
| `npm run smoke:config-import`        | Runs the bundled Worker in Miniflare and imports a config file (default: the golden v1)   |
| `npm run ci`                         | `check` then `typecheck`; run before every push                                           |
| `npm run infra:plan` / `infra:apply` | `tofu init` and `plan` or `apply` in `infra/`                                             |
| `npm run db:generate`                | drizzle-kit writes SQL migrations into `migrations/`                                      |
| `npm run db:generate:mail`           | drizzle-kit writes the tenant mail Durable Object migrations into `migrations/mail/`      |
| `npm run db:migrate`                 | `wrangler d1 migrations apply` on the remote D1                                           |
| `npm run wrangler -- <args>`         | `wrangler` with the Cloudflare token from `cf-env`                                        |
| `npm run deploy -- --bootstrap`      | `db:migrate`, then `wrangler deploy`                                                      |

## Infra

`npm run infra:plan` and `npm run infra:apply` read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `~/.config/reader-cloudflare/cf-env`. The state lives outside the repo in `~/.config/reader-cloudflare/terraform.tfstate`, passed to `tofu init -reconfigure` as `-backend-config=path=...`; `infra/.gitignore` keeps any `*.tfstate` out of git. GitHub holds no Cloudflare token and CI never plans, applies or deploys.

Tofu owns the D1 database, R2 bucket, sync queue, Secrets Store with its `MASTER_KEY`, the `reader-cloudflare` Worker shell and the Access application on `app.remit.email` (one-time PIN). `wrangler.jsonc` carries the matching bindings and the `app.remit.email` custom domain, which attaches on the first deploy. Workers Builds deploys on push to `main`; `npm run deploy -- --bootstrap` exists only for the first deploy, before Workers Builds runs.
