# reader-cloudflare

remit reader on Cloudflare Workers. A TypeScript Worker in `src/`, configured by `wrangler.jsonc`, serving the React web client in `packages/web` as assets; OpenTofu in `infra/` for the Cloudflare account.

## Rules

- TypeScript only. No Python.
- npm workspaces with one lockfile at the root. Current major versions of every tool; Node 24 (`.nvmrc`).
- Biome formats and lints. Run `npm run fix` before every commit.
- Run `npm run ci` before every push.
- `main` is protected. Branch from `origin/main`, run `npm run ci` before pushing, and open a pull request with a conventional title under 72 characters and a four-line body. Arm `gh pr merge --squash --auto`; it squash merges once `ci` is green and deletes the branch.
- Never migrate or re-key existing data on the request path or at Durable Object start; a schema change that reshapes rows means wipe the tenant object and resync, or a D1 migration in `npm run db:migrate`.
- CI is one fast job named `ci`, the required check on `main`: `npm ci`, then `npm run ci`. It runs on every pull request and every push to `main`, and never deploys.
- The Worker logs one JSON object per line through `log` in `src/log.ts`. Workers Observability is on in `wrangler.jsonc`.
- `npm run commit` writes the gitignored `src/commit.ts` from `WORKERS_CI_COMMIT_SHA`, else `git rev-parse HEAD`. `npm run build` runs it first, and `wrangler.jsonc` uses `npm run build` as the build command, so `dev` and `deploy` ship fresh assets; `typecheck` runs it too. `GET /api/config` carries it as `buildCommit`, so a deploy matches a commit; the stale-build reload in `packages/web/src/stale-build.ts` compares it against the loaded bundle.

## What the code does not tell you

1. Reader's handlers, repositories, sync and send all run inside the `TenantMail` Durable Object, because a repository must sit next to its SQLite store. The Worker is the Access boundary and holds none of reader's logic. Its repositories and the D1 app store run on `CLOUDFLARE_SQLITE_LIMITS` in `src/api/config.ts`, 100 bound parameters per statement, the limit both Durable Object SQLite and D1 enforce.
2. Reader's `deriveAccountConfigId` derives the account config id from the Access subject. Every `threadId` and `addressId` embeds it, so changing it means wiping the mail object. A service token's JWT has an empty `sub`, so the Worker takes its `common_name`, the token's client id, as the subject; the agent token gets its own tenant and account config id, apart from every user. A wipe renames the Durable Object class across two deploys, because Cloudflare refuses a class delete and a rebind in one deploy.
3. Work runs on four queues by urgency (sync, mutation, smtp, fanout) plus one shared dead-letter queue. `src/queue/routing.ts` picks the queue from reader's event type, and reader's port names play no part. `MAX_RETRIES` in that file must match each consumer's `max_retries` in `wrangler.jsonc`, so a handler gets `max_retries + 1` tries. `npm run check:retries` (part of `npm run ci`) fails when they differ. Every consumer runs inside the tenant object over a one-slot IMAP pool, which is the account's single connection, and each delivery gets its own 30 s CPU budget. The `*/5 * * * *` cron in `wrangler.jsonc` must match `TICK_INTERVAL_MS` in `src/mail/scheduler-tick.ts`, the dedup bucket of reader's `runSchedulerTick`; `scheduled()` ticks every tenant in `tenant_key` one Durable Object call at a time, and Cloudflare Queues ignore that dedup id, so a sync already queued is held off only by reader's due-check and mailbox lock.
4. When reader and Workers disagree, reader changes. Workers forbid runtime code generation. The `@remit/api-openapi-spec` package ships reader's request validators precompiled. The repo injects every socket as a transport (imapflow `transport`, nodemailer `getSocket`). Cloudflare's `cloudflare:sockets` refuses `rejectUnauthorized: false`. The subpaths the Worker imports (`@remit/backend/serve`, `@remit/backend/handlers`, each worker's `/process`) must stay free of AWS and Lambda code. Fix a break in a reader package in reader, publish it with a `pkgs-v*` tag, then bump it here. Never patch `node_modules`.
5. Workers Builds deploys every push to `main`, with an empty build command and `npm run deploy` as the deploy command, which applies D1 migrations and then runs `wrangler deploy`, whose `build.command` builds. Non-production branch builds are off, and GitHub holds no Cloudflare token. Never deploy from the dev machine. Local scripts read credentials from `~/.config/reader-cloudflare/cf-env` and `cf-bootstrap-env` and never print them. The account runs on Workers Paid because the Free plan's daily Durable Object row-write cap failed API reads (issue #5). This repo is one of three planned composition roots over reader's packages, with AWS and Scaleway next, each on that cloud's native primitives.

## Scripts

| Script                               | Does                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `npm run dev`                        | `wrangler dev` on port 8790, bound to `0.0.0.0`                                         |
| `npm run build`                      | Vite builds the web client into `packages/web/dist`                                     |
| `npm run dashboards`                 | Create or update the Observability saved queries in `npm-scripts/dashboards.mjs`        |
| `npm run tail`                       | `wrangler tail --format pretty` on the deployed Worker, with the token from `cf-env`    |
| `npm run logs -- <minutes> [text]`   | Workers Observability events from the last minutes, one JSON line each                  |
| `npm run commit`                     | Write `src/commit.ts` with the commit sha baked into the Worker                         |
| `npm run fix`                        | Biome rewrites files                                                                    |
| `npm run check`                      | Biome format and lint check                                                             |
| `npm run typecheck`                  | `tsc` over `src` and every package, against declarations `build:vendor-types` emits     |
| `npm run smoke:config-import`        | Runs the bundled Worker in Miniflare and imports a config file (default: the golden v1) |
| `npm run ci`                         | `check`, `check:retries`, then `typecheck`; run before every push                       |
| `npm run e2e`                        | reader's Dovecot and Mailpit, `wrangler dev --env e2e`, Playwright; `E2E_SLOT` names it |
| `npm run infra:plan` / `infra:apply` | `tofu init` and `plan` or `apply` in `infra/`                                           |
| `npm run db:generate`                | drizzle-kit writes SQL migrations into `migrations/`                                    |
| `npm run db:generate:mail`           | drizzle-kit writes the tenant mail Durable Object migrations into `migrations/mail/`    |
| `npm run db:migrate`                 | `wrangler d1 migrations apply` on the remote D1, with the token from `cf-bootstrap-env` |
| `npm run wrangler -- <args>`         | `wrangler` with the Cloudflare token from the environment, else `cf-env`                |
| `npm run deploy`                     | Workers Builds deploy command: `db:migrate`, then `wrangler deploy`; refuses elsewhere  |
| `npm run cf-env:write`               | Write the tofu-minted debug token from state into `cf-env`                              |
| `npm run cf-env:bootstrap-move`      | Rename a hand-made `cf-env` to `cf-bootstrap-env` once, before the first token apply    |
| `npm run access-env:write`           | Write the agent service token from tofu state into `access-env`, mode 600               |
| `npm run api -- <METHOD> <path>`     | Call the deployed API as the agent service token, JSON body third; prints status, body  |
| `npm run smoke:sync`                 | Connect, sync and read the test account on the deployed API; prints counts and timings  |

## Infra

`npm run infra:plan`, `npm run infra:apply` and `npm run db:migrate` read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `~/.config/reader-cloudflare/cf-bootstrap-env`, which only tofu and operators use; agents never read it. The state lives outside the repo in `~/.config/reader-cloudflare/terraform.tfstate`, passed to `tofu init -reconfigure` as `-backend-config=path=...`; `infra/.gitignore` keeps any `*.tfstate` out of git. GitHub holds no Cloudflare token and CI never plans, applies or deploys. The encrypted copies in the dotfiles repo are the source of truth: `infra:apply`, `cf-env:write` and `access-env:write` re-encrypt and push the state, `cf-env` and `access-env` through `npm-scripts/dotfiles-secret.mjs`, and every script that runs tofu restores a missing state first. A new machine restores `cf-env` with `dotfiles-key decrypt reader-cloudflare-cf-env -o ~/.config/reader-cloudflare/cf-env`, and the state with `dotfiles-key decrypt reader-cloudflare-tfstate -o ~/.config/reader-cloudflare/terraform.tfstate`.

Tofu owns the D1 database, R2 bucket, sync queue, Secrets Store with its `MASTER_KEY`, the `reader-cloudflare` Worker shell and the Access application on `app.remit.email`: one-time PIN for the owner, plus a Service Auth policy for the `reader-cloudflare-agent` service token that agents call the API with. `wrangler.jsonc` carries the matching bindings and the `app.remit.email` custom domain, which attaches on the first deploy. Workers Builds deploys on push to `main` through `npm run deploy`, with the token it injects into the deploy step.

The hand-made bootstrap token in `cf-bootstrap-env` holds Account API Tokens Write; Cloudflare refuses that permission on a token another token minted, so it stays hand-made. Tofu mints the `debug` token in `infra/tokens.tf` from permission groups looked up by name: read-biased (Workers scripts, tail, CI, D1, queues and account settings read; observability write for saved queries; on every zone, analytics read plus firewall services, zone WAF and zone settings write), it lives in `cf-env`, which `wrangler`, `tail`, `logs` and `dashboards` read. It has no expiry because it cannot deploy; re-mint it deliberately with `npm run infra:apply -- -replace=cloudflare_account_token.debug`, then `npm run cf-env:write`, which backs up the old file to `cf-env.previous`. `npm run cf-env:bootstrap-move` moves a hand-made `cf-env` to `cf-bootstrap-env` once.
