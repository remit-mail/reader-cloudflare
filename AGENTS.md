# reader-cloudflare

remit reader on Cloudflare Workers. A TypeScript Worker in `src/`, configured by `wrangler.jsonc`; OpenTofu in `infra/` for the Cloudflare account.

## Rules

- TypeScript only. No Python.
- npm workspaces with one lockfile at the root. Current major versions of every tool; Node 24 (`.nvmrc`).
- Biome formats and lints. Run `npm run fix` before every commit.
- Run `npm run ci` before every push.
- Push straight to `main` until the prototype runs end to end.
- CI is one fast job: `npm ci`, `npm run check`, `npm run typecheck`.
- The Worker logs one JSON object per line through `log` in `src/log.ts`. Workers Observability is on in `wrangler.jsonc`.

## Scripts

| Script                               | Does                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `npm run dev`                        | `wrangler dev` on port 8790, bound to `0.0.0.0`        |
| `npm run tail`                       | `wrangler tail --format pretty` on the deployed Worker |
| `npm run fix`                        | Biome rewrites files                                   |
| `npm run check`                      | Biome format and lint check                            |
| `npm run typecheck`                  | `tsc` over `src` and every package                     |
| `npm run ci`                         | `check` then `typecheck`; run before every push        |
| `npm run infra:plan` / `infra:apply` | `tofu init` and `plan` or `apply` in `infra/`          |

## Infra

`npm run infra:plan` and `npm run infra:apply` read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `~/.config/reader-cloudflare/cf-env`. The state lives outside the repo in `~/.config/reader-cloudflare/terraform.tfstate`, passed to `tofu init -reconfigure` as `-backend-config=path=...`; `infra/.gitignore` keeps any `*.tfstate` out of git. GitHub holds no Cloudflare token and CI never plans, applies or deploys.

Tofu owns the D1 database, R2 bucket, sync queue, Secrets Store with its `MASTER_KEY`, the `reader-cloudflare` Worker shell and the Access application on `app.remit.email` (one-time PIN). `wrangler.jsonc` carries the matching bindings and the `app.remit.email` custom domain, which attaches on the first deploy. Workers Builds deploys on push to `main`; nobody runs `wrangler deploy` by hand.
