# Observability

Account `f496802dcadb597e5939f6449c759a43`, Worker `reader-cloudflare`.

## Dashboard paths

| What                                                                                                                             | Path                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Worker metrics: requests, errors, CPU time, wall time percentiles                                                                | Workers & Pages / reader-cloudflare / Metrics                                                |
| Workers Logs, query builder, saved queries                                                                                       | Workers & Pages / reader-cloudflare / Observability                                          |
| Grouped Worker failures                                                                                                          | Workers & Pages / reader-cloudflare / Observability / Issues                                 |
| Durable Objects                                                                                                                  | Workers & Pages / Durable Objects / TenantMailV2, AccountSyncV2 / Metrics                    |
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

| Field                  | Type           | On                                             | Meaning                                                                                                                                                            |
| ---------------------- | -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event`                | string         | all below                                      | `http.response`, `http.error`, `sync.batch`, `sync.pass`, `sync.complete`, `sync.failed`, `sync.dlq`, `queue.consume`, `queue.dlq`, `imap.failure`, `smtp.failure` |
| `correlationId`        | string         | every line                                     | One request, queue message or sync run                                                                                                                             |
| `route`                | string         | every line of a request                        | OpenAPI operationId, or `content`, `assets`, `unmatched`                                                                                                           |
| `tenantId`             | string         | authenticated request lines, sync, send        | Stable tenant id, never an email                                                                                                                                   |
| `method`, `path`       | string         | `http.response`, `http.error`                  | Request method and concrete path                                                                                                                                   |
| `status`               | number         | `http.response`, `http.error`                  | HTTP status                                                                                                                                                        |
| `statusClass`          | string         | `http.response`                                | `2xx`, `3xx`, `4xx`, `5xx`                                                                                                                                         |
| `durationMs`           | number         | `http.*`, `sync.*`                             | Wall time of the request, batch, pass or run                                                                                                                       |
| `errorKind`            | string         | 4xx/5xx responses, `http.error`, `sync.failed` | `quota`, `validation`, `auth`, `notFound`, `conflict`, `notImplemented`, `imap`, `smtp`, `storage`, `credential`, `interrupted`, `client`, `unknown`               |
| `accountId`            | string         | `sync.*`                                       | Mail account                                                                                                                                                       |
| `mailboxId`            | string         | `sync.batch`, `sync.dlq`                       | Mailbox                                                                                                                                                            |
| `messagesFetched`      | number         | `sync.batch`                                   | R2 objects read in the batch                                                                                                                                       |
| `messagesStored`       | number         | `sync.batch`                                   | Messages written to TenantMail                                                                                                                                     |
| `messagesFailed`       | number         | `sync.batch`                                   | Messages skipped as unparseable                                                                                                                                    |
| `bytes`                | number         | `sync.batch`                                   | Raw message bytes read from R2                                                                                                                                     |
| `messagesQueued`       | number         | `sync.complete`                                | Messages dumped to R2 and queued in the run                                                                                                                        |
| `lastMessageSyncAt`    | string         | `sync.complete`                                | ISO time the run finished                                                                                                                                          |
| `action`, `reason`     | string         | `sync.dlq`                                     | `Redriven` or `Dropped`, and why                                                                                                                                   |
| `family`               | string         | `queue.consume`, `queue.dlq`                   | Queue family: `sync`, `mutation`, `smtp`, `fanout`                                                                                                                 |
| `type`                 | string         | `queue.consume`, `queue.dlq`                   | Reader event type, such as `SenderCategoryBackApply`, or `Unreadable`                                                                                              |
| `attempt`              | number         | `queue.consume`, `queue.dlq`                   | Delivery attempt of the queue message                                                                                                                              |
| `outcome`              | string         | `queue.consume`                                | `Acked`, `Retried`, or `Unreachable` when the call to TenantMail itself failed                                                                                     |
| `poolWaitMs`           | number         | `queue.consume` `Acked` and `Retried`          | Time the delivery waited for the account's pooled IMAP connection                                                                                                  |
| `operation`            | string         | `imap.failure`                                 | Reader's failure counter, such as `FLAG_PUSH_EXHAUSTED`                                                                                                            |
| `failureKind`, `count` | string, number | `imap.failure`, `smtp.failure`                 | Reader's mail failure kind, and how many on `imap.failure`                                                                                                         |
| `syncStatus`           | string         | `sync.complete`, `sync.failed`                 | Sync run state: `Idle`, `Running`, `Failed`                                                                                                                        |

The Worker has no CPU clock, so per-batch CPU is read from `$workers.cpuTimeMs` on the invocation.

## Saved queries

`npm run dashboards` creates or updates these saved queries in Observability / Queries, each filtered on `$metadata.service = reader-cloudflare` and named `reader-cloudflare: ...`. The definitions live in `npm-scripts/dashboards.mjs`. The Observability API has saved queries but no dashboards; each saved query renders its own charts over time.

| Saved query                 | Filter                                   | Visualize                                       | Group by                    |
| --------------------------- | ---------------------------------------- | ----------------------------------------------- | --------------------------- |
| requests by status class    | `event = http.response`                  | Count                                           | `statusClass`               |
| 4xx and 5xx by route        | `event = http.response`, `status >= 400` | Count, top 20                                   | `route`, `statusClass`      |
| latency by route            | `event = http.response`                  | Median, P95 `durationMs`, Count                 | `route`, top 20             |
| messages stored per account | `event = sync.batch`                     | Sum `messagesStored`, `messagesFailed`, `bytes` | `accountId`                 |
| sync failures per account   | `event = sync.failed`                    | Count                                           | `accountId`, `errorKind`    |
| queue batches and dlq       | `event in sync.batch, sync.dlq`          | Count, P95 `durationMs`                         | `event`, `action`           |
| queue consumes by family    | `event = queue.consume`                  | Count, P95 `durationMs`, P95 `poolWaitMs`       | `family`, `type`, `outcome` |
| queue dead letters          | `event = queue.dlq`                      | Count                                           | `family`, `type`            |
| errors by kind              | `errorKind exists`                       | Count                                           | `errorKind`, `event`        |

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
