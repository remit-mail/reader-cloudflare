# Observability

Account `f496802dcadb597e5939f6449c759a43`, Worker `reader-cloudflare`.

## Dashboard paths

| What                                                                                                                             | Path                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Worker metrics: requests, errors, CPU time, wall time percentiles                                                                | Workers & Pages / reader-cloudflare / Metrics                                           |
| Workers Logs, query builder, saved queries                                                                                       | Workers & Pages / reader-cloudflare / Observability                                     |
| Grouped Worker failures                                                                                                          | Workers & Pages / reader-cloudflare / Observability / Issues                            |
| Durable Objects                                                                                                                  | Workers & Pages / Durable Objects / TenantMail, TenantSearch, AccountSync / Metrics     |
| D1                                                                                                                               | Storage & Databases / D1 SQL Database / reader-cloudflare / Metrics                     |
| R2                                                                                                                               | Storage & Databases / R2 Object Storage / reader-cloudflare-mail / Metrics              |
| Queues backlog and DLQ depth                                                                                                     | Workers & Pages / Queues / reader-cloudflare-sync, reader-cloudflare-sync-dlq / Metrics |
| Billable usage                                                                                                                   | Manage Account / Billing / Billable Usage                                               |
| Notification policies                                                                                                            | Manage Account / Notifications                                                          |
| Budget alert at 5 and 20 USD (not in OpenTofu, [#7438](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7438)) | Manage Account / Notifications / Add / Billing Budget Alert                             |
| Error rate alert (not in OpenTofu, [#7259](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7259))             | Workers & Pages / reader-cloudflare / Observability / Alerts                            |
| GraphQL explorer                                                                                                                 | https://graphql.cloudflare.com/explorer                                                 |

## Queries

Queries 1 to 4 go into the Observability query builder; save each with Save Query. Queries 5 and 6 go into the GraphQL explorer with variables `{"accountTag": "f496802dcadb597e5939f6449c759a43", "since": "2026-10-01T00:00:00Z", "until": "2026-11-01T00:00:00Z"}`.

### 1. Request duration by path

```text
Visualize: P50($workers.wallTimeMs), P99($workers.wallTimeMs), P99($workers.cpuTimeMs), Count
Filter:    $workers.eventType = fetch
Group by:  $workers.event.request.path
Order by:  P99($workers.wallTimeMs) desc
```

### 2. 5xx by path

```text
Visualize: Count
Filter:    $workers.event.response.status >= 500
Group by:  $workers.event.request.path, $workers.event.response.status
Order by:  Count desc
```

### 3. Sync durations

```text
Visualize: Count, P50(durationMs), P99(durationMs), Max(durationMs)
Filter:    $metadata.message = sync finished
Group by:  accountId
```

Per mailbox: the same with `$metadata.message = mailbox synced` and group by `accountId, mailboxId`. Failures: `$metadata.message = sync failed`, Count, group by `reason`.

### 4. Queue batch durations and retries

```text
Visualize: Count, Sum(count), P50(durationMs), P99(durationMs)
Filter:    $metadata.message = batch processed
Group by:  accountId
```

Retries:

```text
Visualize: Count, Max(attempts)
Filter:    $metadata.message = queue message AND attempts > 1
Group by:  queue
```

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
