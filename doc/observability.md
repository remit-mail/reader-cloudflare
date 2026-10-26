# Observability

Account `f496802dcadb597e5939f6449c759a43`, Worker `reader-cloudflare`.

## Dashboard paths

| What                                                                                                                             | Path                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Worker metrics: requests, errors, CPU time, wall time percentiles                                                                | Workers & Pages / reader-cloudflare / Metrics                                                |
| Workers Logs, query builder, saved queries                                                                                       | Workers & Pages / reader-cloudflare / Observability                                          |
| Grouped Worker failures                                                                                                          | Workers & Pages / reader-cloudflare / Observability / Issues                                 |
| Durable Objects                                                                                                                  | Workers & Pages / Durable Objects / TenantMailV2 / Metrics                                   |
| D1                                                                                                                               | Storage & Databases / D1 SQL Database / reader-cloudflare / Metrics                          |
| R2                                                                                                                               | Storage & Databases / R2 Object Storage / reader-cloudflare-mail / Metrics                   |
| Queues backlog and DLQ depth                                                                                                     | Workers & Pages / Queues / reader-cloudflare-sync, -mutation, -smtp, -fanout, -dlq / Metrics |
| Billable usage                                                                                                                   | Manage Account / Billing / Billable Usage                                                    |
| Notification policies                                                                                                            | Manage Account / Notifications                                                               |
| Budget alert at 5 and 20 USD (not in OpenTofu, [#7438](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7438)) | Manage Account / Notifications / Add / Billing Budget Alert                                  |
| Error rate alert (not in OpenTofu, [#7259](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7259))             | Workers & Pages / reader-cloudflare / Observability / Alerts                                 |
| GraphQL explorer                                                                                                                 | https://graphql.cloudflare.com/explorer                                                      |

## Bookmarks

| What                            | URL                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Worker metrics                  | https://dash.cloudflare.com/f496802dcadb597e5939f6449c759a43/workers/services/view/reader-cloudflare/production/metrics |
| Observability and saved queries | https://dash.cloudflare.com/f496802dcadb597e5939f6449c759a43/workers-and-pages/observability                            |
| Durable Objects                 | https://dash.cloudflare.com/f496802dcadb597e5939f6449c759a43/workers/durable-objects                                    |
| Queues                          | https://dash.cloudflare.com/f496802dcadb597e5939f6449c759a43/workers/queues                                             |

## Log fields

Every line is one JSON object from `log` in `src/log.ts`. Lines that feed a dashboard carry an `event`.

| Field                         | Type           | On                                               | Meaning                                                                                                                                              |
| ----------------------------- | -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`                       | string         | all below                                        | `http.response`, `http.error`, `queue.consume`, `queue.dlq`, `imap.failure`, `smtp.failure`                                                          |
| `message`                     | string         | every line                                       | Free text; reader's sync handlers key their lines on it, such as `Message sync batch complete` and `Body sync complete`                              |
| `correlationId`               | string         | every line                                       | One request or queue message                                                                                                                         |
| `route`                       | string         | every line of a request                          | OpenAPI operationId, or `content`, `assets`, `unmatched`                                                                                             |
| `tenantId`                    | string         | authenticated request lines, queue consumes      | Stable tenant id, never an email                                                                                                                     |
| `method`, `path`              | string         | `http.response`, `http.error`                    | Request method and concrete path                                                                                                                     |
| `status`                      | number         | `http.response`, `http.error`                    | HTTP status                                                                                                                                          |
| `statusClass`                 | string         | `http.response`                                  | `2xx`, `3xx`, `4xx`, `5xx`                                                                                                                           |
| `durationMs`                  | number         | `http.*`, `queue.consume`                        | Wall time of the request or delivery                                                                                                                 |
| `errorKind`                   | string         | 4xx/5xx responses, `http.error`, `queue.consume` | `quota`, `validation`, `auth`, `notFound`, `conflict`, `notImplemented`, `imap`, `smtp`, `storage`, `credential`, `interrupted`, `client`, `unknown` |
| `accountId`                   | string         | lines inside a delivery for one account          | Mail account                                                                                                                                         |
| `syncedCount`                 | number         | `Message sync batch complete`                    | Envelopes reader's message sync stored in the batch                                                                                                  |
| `synced`, `skipped`, `failed` | number         | `Body sync complete`                             | Bodies reader's body sync stored, already held, or failed in the batch                                                                               |
| `family`                      | string         | `queue.consume`, `queue.dlq`                     | Queue family: `sync`, `mutation`, `smtp`, `fanout`                                                                                                   |
| `type`                        | string         | `queue.consume`, `queue.dlq`                     | Reader event type, such as `SenderCategoryBackApply`, or `Unreadable`                                                                                |
| `attempt`                     | number         | `queue.consume`, `queue.dlq`                     | Delivery attempt of the queue message                                                                                                                |
| `outcome`                     | string         | `queue.consume`                                  | `Acked`, `Retried`, or `Unreachable` when the call to TenantMail itself failed                                                                       |
| `poolWaitMs`                  | number         | `queue.consume` `Acked` and `Retried`            | Time the delivery waited for the account's pooled IMAP connection                                                                                    |
| `operation`                   | string         | `imap.failure`                                   | Reader's failure counter, such as `FLAG_PUSH_EXHAUSTED`                                                                                              |
| `failureKind`, `count`        | string, number | `imap.failure`, `smtp.failure`                   | Reader's mail failure kind, and how many on `imap.failure`                                                                                           |

The Worker has no CPU clock, so per-batch CPU is read from `$workers.cpuTimeMs` on the invocation.

## Saved queries

`npm run dashboards` creates or updates these saved queries in Observability / Queries, each filtered on `$metadata.service = reader-cloudflare` and named `reader-cloudflare: ...`. The definitions live in `npm-scripts/dashboards.mjs`. The Observability API has saved queries but no dashboards; each saved query renders its own charts over time.

| Saved query                 | Filter                                                        | Visualize                                 | Group by                        |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| requests by status class    | `event = http.response`                                       | Count                                     | `statusClass`                   |
| 4xx and 5xx by route        | `event = http.response`, `status >= 400`                      | Count, top 20                             | `route`, `statusClass`          |
| latency by route            | `event = http.response`                                       | Median, P95 `durationMs`, Count           | `route`, top 20                 |
| messages synced per account | `message = Message sync batch complete`                       | Sum `syncedCount`, Count                  | `accountId`                     |
| bodies synced per account   | `message = Body sync complete`                                | Sum `synced`, `skipped`, `failed`         | `accountId`                     |
| sync failures per tenant    | `event = queue.consume`, `family = sync`, `outcome = Retried` | Count                                     | `tenantId`, `type`, `errorKind` |
| imap failures               | `event = imap.failure`                                        | Sum `count`                               | `operation`, `failureKind`      |
| queue consumes by family    | `event = queue.consume`                                       | Count, P95 `durationMs`, P95 `poolWaitMs` | `family`, `type`, `outcome`     |
| queue dead letters          | `event = queue.dlq`                                           | Count                                     | `family`, `type`                |
| errors by kind              | `errorKind exists`                                            | Count                                     | `errorKind`, `event`            |

## GraphQL

Queries 5 and 6 go into the GraphQL explorer with variables `{"accountTag": "f496802dcadb597e5939f6449c759a43", "since": "2026-10-01T00:00:00Z", "until": "2026-11-01T00:00:00Z"}`.

### 5. Durable Object requests

```graphql
query DurableObjects($accountTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 1000
        filter: { scriptName: "reader-cloudflare", datetime_geq: $since, datetime_lt: $until }
        orderBy: [date_ASC]
      ) {
        dimensions {
          date
          namespaceId
          status
        }
        sum {
          requests
          errors
        }
        quantiles {
          wallTimeP50
          wallTimeP99
        }
      }
    }
  }
}
```

### 6. R2 operations

```graphql
query R2Operations($accountTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 1000
        filter: { bucketName: "reader-cloudflare-mail", datetime_geq: $since, datetime_lt: $until }
        orderBy: [date_ASC]
      ) {
        dimensions {
          date
          actionType
          actionStatus
        }
        sum {
          requests
          responseObjectSize
        }
      }
    }
  }
}
```
