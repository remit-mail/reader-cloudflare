# RFC: cloud-native reader

## Summary

This build runs remit reader on Cloudflare. The repo wires reader's published packages to Cloudflare's services. It also holds the infrastructure. Reader's packages bring the web client, the API contract, the handlers, the repositories and the body sync. Cloudflare Access signs the user in. Settings live in one shared database. Each user gets their own mail database, which also holds the search index. The same wiring targets AWS and Scaleway next.

Each decision below carries a number. Disagree by number.

## Platform and tenants

1. The build runs on Cloudflare: Workers, D1, Durable Objects, R2, Queues, Secrets Store and Access. The repo carries no UI, no API handlers and no database layer for the shared parts (decision 16).
2. Cloudflare Access is the only sign-in. The Access JWT, from the cookie or a bearer header, is the identity. Switching the provider (one-time PIN today, Google or GitHub later) is a Tofu change. Access admits the `owner_emails` in the deployment config only.

## Storage

3. One shared D1 database holds reader's app schema set, all 11 tables, for every tenant. It adds one Cloudflare-only table, `tenant_key`. A tenant owns the account config whose id is reader's `deriveAccountConfigId` of the Access subject. Every other app row hangs off that config, as in reader. Inside the mail object, `composeSqliteRepositories({ app: D1, mail, search })` composes every repository. Every queue consumer runs inside it too, so no mail row crosses an RPC boundary.
4. Each tenant gets one mail Durable Object on SQLite. It runs reader's mail repositories and `SearchIndex` from `@remit/drizzle-service` over its own SQLite handle, with `syncBatch` as the write port. The FTS5 table sits in the same database, because reader's index reads the mail rows directly. It tokenizes with unicode61, as reader does. The same database holds reader's search-text table and the index on normalized email. A Durable Object starts on first use, so a new tenant needs no deploy.
5. Message bodies and attachments live in R2, outside the mail database.
6. No code uses an interactive transaction. A write is an atomic batch or an idempotent step that is safe to repeat. A queue can deliver a message twice. Two tabs can start the same sync.
7. Every schema is Drizzle sqlite-core. Reader's mail schema set generates the mail database's migrations. Reader's FTS5 DDL adds custom migrations. A small TypeSpec here generates the Cloudflare-only table. It uses reader's emitter and entity vocabulary.

## Credentials

8. Credentials use envelope encryption. One master key lives in Secrets Store. Each tenant gets a random data key, wrapped by the master key. That key provider backs reader's secrets service, so a password lives sealed on reader's account row as `passwordHash`. The repo has no credential table. Every wrapped key carries a key version, so a key can rotate. Where a provider supports OAuth, it takes priority over an app password.

## Sync and schema updates

9. Each mail object holds reader's IMAP connection pool, built by `createConnectionPool({ size: 1, overflow: "Wait" })` over the Workers socket transport. Each account gets one pooled connection. A second borrow waits for the first to release it, so one account's IMAP work runs in order. The read path borrows the same connection: when `describeMessage` backfills a body the batch has not stored yet, its lease waits for the queue consumers and releases when the fetch ends or fails. The mutation consumer runs reader's `processEvent` inside the mail object, over that pool. Each attempt budget equals its queue's `max_retries + 1`, and `npm run ci` fails when the two disagree. The smtp consumer runs reader's `handleSendMessage` in the mail object too, with nodemailer over the Workers socket, and files the Sent copy through `APPEND_SENT_MESSAGE` on the mutation queue. OAuth accounts mint their access tokens through reader's Microsoft token service, so they sync and send like password accounts. The sync consumer runs reader's `syncMailboxes`, `syncMessages` and `syncMessageBody` through `processEvent` over the same pool. Reader's `getConfig`, `createAccount` and `triggerSync` put `SYNC_MAILBOXES` on the sync queue; a sync not asked for by name skips mailboxes synced in the last 60 seconds. Body sync fetches from IMAP in batches of 25 and stores each body in R2 through reader's storage port. Sync status lives on reader's account row.
10. Each mail object applies its own schema migrations when it starts. It skips them when the newest one is already applied. No data migration runs on the request path or at object start.

## Delivery

11. OpenTofu in `infra/` manages the account resources, named from the deployment config, which lives outside the repo. `wrangler.jsonc` carries the portable Worker settings, and the deploy renders the bindings from the Tofu outputs. Workers Builds deploys every push to main.
12. Until a real end-to-end user test works, the prototype pushes straight to main with no PRs. CI runs lint and typecheck only. `npm run e2e` runs reader's flows against the Worker under `wrangler dev`. Workers Logs and `wrangler tail` cover the deployed Worker.

## Shared code

13. The repo owns the Access identity to tenant mapping and the port adapters that plug D1, Durable Objects, R2, Secrets Store and the queue into reader's ports. It also owns the socket plumbing: imapflow over a `cloudflare:sockets` transport, and nodemailer over a `getSocket` on `node:tls` and `node:net`.
14. The web client is `@remit/web-client`, mounted with an Access auth provider. The Worker is the Access boundary only. It verifies the JWT, derives the caller's identity and forwards `/api` to the tenant's mail object. That object serves reader's `handlers` and `publicHandlers` through `serveApi` and `handleFetch` from `@remit/backend/serve`, less an explicit list of operations this host does not serve, which answer 501. Two routes skip Access: the calendar feed and the Microsoft OAuth callback, each behind a Tofu bypass application scoped to its path. The Worker finds their tenant through the `tenant_account_config` table, written in the same batch as the tenant's data key: by the account config id on the feed token row, or by the one in the OAuth state once the Worker has verified its signature. `ApiConfig` runs in `GatewayAuthorizer` mode. The client is reader's full `createRemitClient` composition over reader's repositories, an R2 storage adapter, the Secrets Store key provider, a `connectionScope` that leases the mail object's pool (decision 9), and the queue producers of decision 21. `/content` serves the body parts reader stores in R2 behind Access with no URL signature, scoped to the caller's account config.
15. Handlers come from `@remit/backend`, and repositories and schema sets from `@remit/drizzle-service`. `@remit/mailbox-service` runs the body sync. `@remit/data-ports` and `@remit/domain-enums` supply the ports and enums. `@remit/logger` defines the logger, and the repo injects its Workers adapter. Every reader package sits at its `pkgs-v0.3.0` release. The web package keeps looser TypeScript settings until `@remit/web-client` and `@remit/data-ports` publish compiled output.

## Composition and operations

16. The repo is a composition root over reader's published packages. It holds adapters and wiring and no copy of reader's code. AWS and Scaleway come next through the same seams, each on that cloud's native primitives.
17. The one Durable Object class is `TenantMailV3`, behind the unchanged `TENANT_MAIL` binding. Migration v5 added the V2 classes. Migration v6 deleted the old classes and every object they held. That wiped each tenant's mail store on 2026-10-25, and a fresh IMAP sync filled reader's schema. The D1 app tables stayed. Migration v7 deleted `AccountSyncV2` and its `ACCOUNT_SYNC` binding once the sync ran on the queue. Reader derives the account config id from the Access subject, and every thread and address id embeds it, so re-keying the prototype account configs on 2026-10-26 meant a second wipe: migration v8 added `TenantMailV3`, and v9 deleted `TenantMailV2` with every object it held.
18. A Cloudflare quota or limit error answers 429 with `errorKind` `quota`. Inside reader's handlers it becomes reader's `HostRefusedError`, which reader answers with 429 `request_refused`. Any other unhandled error answers 500.
19. The Worker logs one JSON object per line. Each line carries a correlation id, and the response returns it as `x-correlation-id`. Workers Observability is on. Ten saved queries come from `npm run dashboards`. The dashboard paths and alerts are listed in `doc/observability.md`.
20. The account runs on Workers Paid. On Free, the daily Durable Object row-write cap failed API reads (issue #5).
21. Four work queues carry reader's events: `sync`, `mutation`, `smtp` and `fanout`. TenantMail wraps every event in an envelope `{ v: 1, tenantId, correlationId, event }`. A typed table maps each reader `event.type` to its queue, because reader's `sync` port carries both IMAP reads and IMAP writes. Cloudflare Queues have no groups and no deduplication, so the producers drop both, and reader's handlers are idempotent. The Worker hands each delivery to the tenant's TenantMail and acks or retries it. All four share one dead-letter queue, whose consumer logs `queue.dlq` and acks.

## Open risks

A Worker has 128 MB of memory, so bodies stream to R2 and batches stay small. Gmail allows about 15 connections per account.

## FAQ

### Why not one D1 database per tenant?

D1 bindings are fixed at deploy time. Durable Objects start on demand, so new tenants arrive without a deploy (decision 4).

### Why keep search inside the mail object?

Reader's index selects from the mail tables when it writes and when it rebuilds, so it needs the same database (decision 4).

### How do queue consumers reach IMAP?

Through reader's connection pool in the tenant's mail object. One connection per account stays well under Gmail's limit of about 15. A second consumer waits for that connection, so an account's IMAP writes run in order (decision 9).

### Why not write the handlers here?

Reader's handlers already serve the same contract. A fix in reader reaches this build with the next package update (decisions 15 and 16).

### Why rename the mail and sync classes?

Deleting a class drops all its objects. New names kept the bindings live while the old stores went (decision 17).

### Why not migrate the old mail rows?

The store was wiped and synced again from IMAP. No data migration runs at request time or object start (decisions 10 and 17).

### Why no tests in CI yet?

The prototype relies on logs and the local e2e run until the user test passes (decision 12).

### Can it run on AWS?

Yes, that build comes next. It plugs AWS services into the same ports, and Scaleway follows (decision 16).

## Appendix

| Term       | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| Tenant     | One user, keyed by Access identity                        |
| App DB     | The shared D1 database for app and Cloudflare-only tables |
| Mail DB    | Per-tenant Durable Object SQLite: IMAP state and FTS5     |
| Port       | A reader interface that a platform adapter implements     |
| Data key   | Random per-tenant key that encrypts credentials           |
| Master key | The Secrets Store key that wraps every data key           |

Background: [remit-mail/reader#1420](https://github.com/remit-mail/reader/issues/1420) splits reader's single SQLite file the same way. Pull request reader#1425 implements that split.
