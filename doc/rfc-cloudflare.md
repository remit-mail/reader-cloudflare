# RFC: cloud-native reader

## Summary

This build runs remit reader on Cloudflare. The repo wires reader's published packages to Cloudflare's services. It also holds the infrastructure. Reader's packages bring the web client, the API contract, the handlers, the repositories and the body sync. Cloudflare Access signs the user in. Settings live in one shared database. Each user gets their own mail database, which also holds the search index. The same wiring targets AWS and Scaleway next.

Each decision below carries a number. Disagree by number.

## Platform and tenants

1. The build runs on Cloudflare: Workers, D1, Durable Objects, R2, Queues, Secrets Store and Access. The repo carries no UI, no API handlers and no database layer for the shared parts (decision 16).
2. Cloudflare Access is the only sign-in. The Access JWT, from the cookie or a bearer header, is the identity. Switching the provider (one-time PIN today, Google or GitHub later) is a Tofu change. Access admits matthijs@ischen.nl only.

## Storage

3. One shared D1 database holds reader's app schema set, all 11 tables, for every tenant. It adds one Cloudflare-only table, `tenant_key`. A tenant owns the account config whose id is reader's `deriveAccountConfigId` of the Access subject. Every other app row hangs off that config, as in reader. Inside the mail object, `composeSqliteRepositories({ app: D1, mail, search })` composes every repository. Outside it, the sync object and the queue consumers reach mail rows through thin RPC ports.
4. Each tenant gets one mail Durable Object on SQLite. It runs reader's mail repositories and `SearchIndex` from `@remit/drizzle-service` over its own SQLite handle, with `syncBatch` as the write port. The FTS5 table sits in the same database, because reader's index reads the mail rows directly. It tokenizes with unicode61, as reader does. The same database holds reader's search-text table and the index on normalized email. A Durable Object starts on first use, so a new tenant needs no deploy.
5. Message bodies and attachments live in R2, outside the mail database.
6. No code uses an interactive transaction. A write is an atomic batch or an idempotent step that is safe to repeat. A queue can deliver a message twice. Two tabs can start the same sync.
7. Every schema is Drizzle sqlite-core. Reader's mail schema set generates the mail database's migrations. Reader's FTS5 DDL adds custom migrations. A small TypeSpec here generates the Cloudflare-only table. It uses reader's emitter and entity vocabulary.

## Credentials

8. Credentials use envelope encryption. One master key lives in Secrets Store. Each tenant gets a random data key, wrapped by the master key. That key provider backs reader's secrets service, so a password lives sealed on reader's account row as `passwordHash`. The repo has no credential table. Every wrapped key carries a key version, so a key can rotate. Where a provider supports OAuth, it takes priority over an app password.

## Sync and schema updates

9. The browser starts a sync and polls its status. A Durable Object per account owns the single IMAP connection. The run continues after the request returns, in alarm-driven passes. It fetches newest first in batches of ten and streams raw RFC822 to R2 under reader's body key. Then it writes each message's envelope, addresses and thread row to the mail object from the IMAP envelope. The sync object sends one queue message per batch. Sync status lives on reader's account row. Consumers never open IMAP. A message moves to the dead-letter queue after 3 retries, which redrives it once.
10. Each mail object applies its own schema migrations when it starts. It skips them when the newest one is already applied. No data migration runs on the request path or at object start.

## Delivery

11. OpenTofu in `infra/` manages the account resources. `wrangler.jsonc` configures the Worker. Workers Builds will deploy every push to main, but the repo is not connected to it yet. Until then, the bootstrap deploy runs from the dev machine.
12. Until a real end-to-end user test works, the prototype pushes straight to main with no PRs. CI runs lint and typecheck only. `npm run e2e` runs reader's flows against the Worker under `wrangler dev`. Workers Logs and `wrangler tail` cover the deployed Worker.

## Shared code

13. The repo owns the Access identity to tenant mapping and the port adapters that plug D1, Durable Objects, R2, Secrets Store and the queue into reader's ports. It also owns the socket plumbing: imapflow over a `cloudflare:sockets` transport, and nodemailer over a `getSocket` on `node:tls` and `node:net`.
14. The web client is `@remit/web-client`, mounted with an Access auth provider. The Worker is the Access boundary only. It verifies the JWT, derives the caller's identity and forwards `/api` to the tenant's mail object. That object serves reader's handlers through `serveApi` and `handleFetch` from `@remit/backend/serve`. `ApiConfig` runs in `GatewayAuthorizer` mode. The client is a `RemitClient<never>` over reader's repositories, an R2 storage adapter and the Secrets Store key provider. `/content` serves body parts behind Access with no URL signature, scoped to the caller's account config.
15. Handlers come from `@remit/backend`, and repositories and schema sets from `@remit/drizzle-service`. `@remit/mailbox-service` runs the body sync. `@remit/data-ports` and `@remit/domain-enums` supply the ports and enums. `@remit/logger` defines the logger, and the repo injects its Workers adapter. Every reader package sits at its `pkgs-v0.2.2` release.

## Composition and operations

16. The repo is a composition root over reader's published packages. It holds adapters and wiring and no copy of reader's code. AWS and Scaleway come next through the same seams, each on that cloud's native primitives.
17. The Durable Object classes are `TenantMailV2` and `AccountSyncV2`, behind the unchanged `TENANT_MAIL` and `ACCOUNT_SYNC` bindings. Migration v5 added the V2 classes. Migration v6 deleted the old classes and every object they held. That wiped each tenant's mail store on 2026-10-25, and a fresh IMAP sync filled reader's schema. The D1 app tables stayed.
18. A Cloudflare quota or limit error answers 429 with `errorKind` `quota`. Any other unhandled error answers 500.
19. The Worker logs one JSON object per line. Each line carries a correlation id, and the response returns it as `x-correlation-id`. Workers Observability is on. Seven saved queries come from `npm run dashboards`. The dashboard paths and alerts are listed in `doc/observability.md`.
20. The account runs on Workers Paid. On Free, the daily Durable Object row-write cap failed API reads (issue #5).

## Interim

1. The client composes no queue yet, so reader serves every operation that sends to none. Ten operations need a queue and run local handlers in `src/api/local` over the same client. `getConfig`, `createAccount` and `triggerSync` send to the sync queue. `updateAddress` sends to the account fan-out queue. `describeMessage`, `updateMessageFlags` and `updateFlags` need the body and flag queues. `createOutboxMessage`, `updateOutboxMessage` and `sendOutboxMessage` need the SMTP queue. Each goes once its queue has a Cloudflare consumer. Every other queue operation answers 501.
2. Superseded.
3. The web package keeps looser TypeScript settings. They tighten once `@remit/web-client` and `@remit/data-ports` publish compiled output.
4. A sync pass takes the newest 200 messages per mailbox. Later passes backfill older mail.
5. The queue consumer runs reader's `BodySyncService.syncBodies` inside the mail object, over an R2-backed body source. Reader classifies each message and writes its snippet and search text. Placement moves, filters, unsubscribe auto-read and calendar cards stay off. Each needs a queue consumer that drives IMAP or writes the calendar, and each arrives with that consumer.

## Open risks

A Worker has 128 MB of memory, so bodies stream to R2 and batches stay small. Gmail allows about 15 connections per account.

## FAQ

### Why not one D1 database per tenant?

D1 bindings are fixed at deploy time. Durable Objects start on demand, so new tenants arrive without a deploy (decision 4).

### Why keep search inside the mail object?

Reader's index selects from the mail tables when it writes and when it rebuilds, so it needs the same database (decision 4).

### Why can't queue consumers fetch from IMAP?

The Gmail connection limit leaves room for one connection per account, owned by the sync object (decision 9).

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
| Sync DO    | Per-account Durable Object that owns the IMAP connection  |
| Port       | A reader interface that a platform adapter implements     |
| Data key   | Random per-tenant key that encrypts credentials           |
| Master key | The Secrets Store key that wraps every data key           |

Background: [remit-mail/reader#1420](https://github.com/remit-mail/reader/issues/1420) splits reader's single SQLite file the same way. Pull request reader#1425 implements that split.
