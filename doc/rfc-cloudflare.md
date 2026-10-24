# RFC: cloud-native reader

## Summary

This build runs remit reader on Cloudflare alone. Cloudflare Access signs the user in. Each user is a tenant with their own mail accounts. Settings and credentials live in one shared database. Each tenant's mail and search index live in their own small databases, created on first use. Message bodies sit in object storage. The browser starts each sync. A queue spreads the follow-up work, and only the sync step talks to the mail server. The storage split follows reader#1420, so the same code can later run on other providers.

Each decision below carries a number. Disagree by number.

## Platform and tenants

1. The build is cloud-native on Cloudflare: Workers, D1, Durable Objects, R2, Queues, Secrets Store and Access. Other cloud providers get their own builds later. The storage code reaches each driver through one thin adapter.
2. Cloudflare Access handles sign-in, and the Access identity is the tenant id. A tenant is one user with one or more mail accounts. Access already proves who the user is, so the Worker runs no auth service of its own.

## Storage

3. The app DB is D1. It holds the state that lives in the client. That is accounts, config (already transferable), rules, labels, settings and encrypted credentials. Labels are reader's own labels, separate from Gmail labels.
4. Tenant data is everything that lives on the IMAP server. Each tenant gets a mail DB and a separate FTS5 search DB, both Durable Object SQLite. D1 bindings are fixed at deploy time, and a Durable Object is created on first use. Search rebuilds from message bodies, so it never commits atomically with mail.
5. Message bodies and attachments live in R2, outside the mail DB.
6. No code uses an interactive transaction. A write is an atomic batch or an idempotent step that is safe to repeat. A queue can deliver a message twice. Two tabs can start the same sync.
7. Every schema is a Drizzle sqlite-core schema. The code adds no raw SQL and no new emitter.

## Credentials

8. Credentials use envelope encryption. One master key lives in Secrets Store. Each tenant gets a random data key, wrapped by the master key. Every ciphertext carries a key version, so a key can rotate. Where a provider supports OAuth, it takes priority over an app password.

## Sync and schema updates

9. Sync v1 is client-driven, as in the Lambda build, with no timers and no cron. The sync step dumps raw mail to R2. Queue consumers read from R2 and fan out the processing. They never open IMAP, because Gmail allows about 15 connections per account. Steps are idempotent, so the queue needs no FIFO ordering. Background sync comes later.
10. Mail schema updates apply per tenant through remit's existing update flow. Orchestrated upgrades build on that flow later.

## Delivery

11. OpenTofu in `infra/` manages the account resources. `wrangler.jsonc` configures the Worker. Workers Builds deploys on every push to main, the same pattern as [stallion](https://github.com/mvhenten/stallion).
12. Until a real end-to-end user test works, the prototype pushes straight to main with no PRs. CI runs lint and typecheck only. Workers Logs and `wrangler tail` stand in for tests.

## Reused reader packages

The web client ships as Worker assets and reuses packages from remit-mail/reader. `@remit/ui`, `@remit/data-ports`, `@remit/domain-enums`, `@remit/config-format` and `@remit/config-transfer` carry no AWS SDK and no better-sqlite3 dependency. `@remit/web-client` publishes the app shell and the auth shells as separate primitives. Its auth shells depend on Amplify and better-auth, so this build composes its own shell around Access. The entity schema comes from the generated `@remit/drizzle-sqlite-schema`.

## Open risk

imapflow and nodemailer need TLS and STARTTLS on Workers. A spike is testing both now. A Worker has 128 MB of memory, so fetch batches stay small or stream bodies straight to R2.

## FAQ

### Why not one D1 database per tenant?

New tenants arrive without a deploy, because Durable Objects start on demand (decision 4).

### Why split search from mail?

The index is rebuildable, so atomic writes with mail buy nothing (decision 4).

### Why can't queue consumers fetch from IMAP?

The Gmail connection limit leaves room for the sync step only (decision 9).

### Why no tests yet?

Decision 12: the prototype relies on logs until the user test passes.

### Can it run on AWS?

Not this build. Another provider gets its own build and its own storage adapter.

## Appendix

| Term | Meaning |
| --- | --- |
| Tenant | One user, keyed by Access identity |
| App DB | The D1 database for client-side state |
| Mail DB | Per-tenant Durable Object SQLite for IMAP-side state |
| Search DB | Per-tenant Durable Object SQLite holding the FTS5 index |
| Data key | Random per-tenant key that encrypts credentials |
| Master key | The Secrets Store key that wraps every data key |

Background: [remit-mail/reader#1420](https://github.com/remit-mail/reader/issues/1420) splits reader's single SQLite file the same way.
