# RFC: cloud-native reader

## Summary

This build runs remit reader on Cloudflare. The repo holds the infrastructure, a thin wrapper and the data that only Cloudflare needs. Everything shared comes from reader's published packages: the web client, the API contract, the handlers and the storage code. Cloudflare Access signs the user in. Settings live in one shared database, and each user gets their own mail database, which also holds the search index.

Each decision below carries a number. Disagree by number.

## Platform and tenants

1. The build is cloud-native on Cloudflare: Workers, D1, Durable Objects, R2, Queues, Secrets Store and Access. The repo carries no UI, no API handlers and no database layer for the shared parts. Other providers get their own builds.
2. Cloudflare Access is the only sign-in. The Access JWT, from the cookie or a bearer header, is the identity. Access has no password store, so the build has none. Switching the provider (one-time PIN today, Google or GitHub later) is a Tofu change. Access admits matthijs@ischen.nl only.

## Storage

3. One shared D1 database holds reader's app schema set, all 11 tables, for every tenant, plus three Cloudflare-only tables: `tenant_account`, `credential` and `tenant_key`. The Worker composes reader's settings repositories over `drizzle-orm/d1` per request. A tenant owns the account config whose `user_id` is its derived user id, and every other app row hangs off that config, as in reader. The repositories that read mail rows (account config, account, config import) reach the tenant's mail object through thin RPC ports.
4. Each tenant gets one mail Durable Object on SQLite. It runs reader's mail repositories and `SearchIndex` from `@remit/drizzle-service` over its own SQLite handle, with `syncBatch` as the write port. The FTS5 table sits in the same database, because reader's index reads the mail rows directly. It is written after each mail write and rebuilds from the mail rows when the counts disagree. A Durable Object starts on first use, so a new tenant needs no deploy.
5. Message bodies and attachments live in R2, outside the mail database.
6. No code uses an interactive transaction. A write is an atomic batch or an idempotent step that is safe to repeat. A queue can deliver a message twice. Two tabs can start the same sync.
7. Every schema is Drizzle sqlite-core. The mail database's migrations are generated from reader's mail schema set, plus reader's FTS5 DDL as one custom migration. A small TypeSpec here generates the three Cloudflare-only tables. It uses reader's emitter and entity vocabulary.

## Credentials

8. Credentials use envelope encryption. One master key lives in Secrets Store. Each tenant gets a random data key, wrapped by the master key. Every row carries a key version, so a key can rotate. Where a provider supports OAuth, it takes priority over an app password.

## Sync and schema updates

9. The browser starts a sync and polls its status. A Durable Object per account owns the single IMAP connection. The run continues after the request returns: `waitUntil` today, an alarm later. It fetches newest first in small batches, streams raw RFC822 to R2 and sends one queue message per batch. Queue consumers parse from R2 and write to the mail object. They never open IMAP. A message moves to the dead-letter queue after 3 retries.
10. Each mail object applies its own schema migrations when it starts.

## Delivery

11. OpenTofu in `infra/` manages the account resources. `wrangler.jsonc` configures the Worker. Workers Builds will deploy every push to main, but the repo is not connected to it yet. Until then, the bootstrap deploy runs from devbox.
12. Until a real end-to-end user test works, the prototype pushes straight to main with no PRs. CI runs lint and typecheck only. Workers Logs and `wrangler tail` stand in for tests.

## Shared code

13. The repo owns the Access identity to tenant mapping and the port adapters that plug D1, Durable Objects, R2 and the queue into reader's ports. It also owns the socket plumbing: imapflow over a `cloudflare:sockets` transport, and nodemailer over a `getSocket` on `node:tls` and `node:net`.
14. The web client is `@remit/web-client`, mounted with an Access auth provider. The Worker serves the API contract from `@remit/api-openapi-spec` through openapi-backend at `/api` and `/content`, typed by `@remit/api-zod-schemas` and `@remit/api-openapi-types`.
15. Handlers come from `@remit/backend`, and repositories and schema sets from `@remit/drizzle-service`. `@remit/data-ports` and `@remit/domain-enums` supply the ports and enums. `@remit/logger` defines the logger, and the repo injects its Workers adapter.

## Interim

1. Handlers for the needed operations live in this repo and call reader's repositories inside the mail object. `@remit/backend` handlers read one process-wide client and an API Gateway event, which a Worker serving many tenants cannot share. They go once reader injects the repositories per request.
2. Three list-wrapper types are hand-written. They go once reader's TypeSpec names them.
3. The web package keeps looser TypeScript settings. They tighten once `@remit/web-client` and `@remit/data-ports` publish compiled output.
4. A sync run takes the newest 200 messages per mailbox. A later backfill fetches the older ones.

## Open risks

A Worker has 128 MB of memory, so bodies stream to R2 and batches stay small. `waitUntil` caps how long a detached run lives. Gmail allows about 15 connections per account.

## FAQ

### Why not one D1 database per tenant?

D1 bindings are fixed at deploy time. Durable Objects start on demand, so new tenants arrive without a deploy (decision 4).

### Why keep search inside the mail object?

Reader's index selects from the mail tables when it writes and when it rebuilds, so it needs the same database (decision 4).

### Why can't queue consumers fetch from IMAP?

The Gmail connection limit leaves room for one connection per account, owned by the sync object (decision 9).

### Why not write the handlers here?

Reader's handlers already serve the same contract. The build reuses them, so a fix in reader reaches it with the next package update (decisions 1 and 15).

### Why no tests yet?

Decision 12: the prototype relies on logs until the user test passes.

### Can it run on AWS?

Not this build. Another provider gets its own build and its own port adapters.

## Appendix

| Term       | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| Tenant     | One user, keyed by Access identity                        |
| App DB     | The shared D1 database for app and Cloudflare-only tables |
| Mail DB    | Per-tenant Durable Object SQLite: IMAP state and FTS5     |
| Sync DO    | Per-account Durable Object that owns the IMAP connection  |
| Port       | A reader interface that a platform adapter implements     |
| Data key   | Random per-tenant key that encrypts credentials           |
| Master key | The Secrets Store key that wraps every data key           |

Background: [remit-mail/reader#1420](https://github.com/remit-mail/reader/issues/1420) splits reader's single SQLite file the same way. Pull request reader#1425 implements that split.
