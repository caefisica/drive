# Architecture

## Indexing

Each configured drive has one `sync_state` row. A drive is indexed in two
phases: an initial crawl that walks every folder, then incremental syncs that
apply Google's change feed from a stored page token.

`syncDrive` (`src/services/drive-sync.ts`) is the entry point for both. The cron
(`crons/sync.ts`) and the webhook (`routes/api/webhook/[driveIdx].ts`) call it.
It runs an incremental sync when the drive has a page token. Otherwise it queues
the crawl `init` message that starts the initial crawl.

## sync_state

| Column               | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `page_token`         | Cursor into the change feed. Null until an init has run.           |
| `last_synced_at`     | When the page token was last stored.                               |
| `crawl_requested_at` | When `init` was queued. Cleared when the init stores a page token. |
| `status`             | One of the values below.                                           |

### Statuses

| Status     | Written by                                                                                           | Meaning                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `idle`     | `runIncrementalSync` when it finishes. Column default. Reset by `syncDrive` if the queue send fails. | No work in progress.                                             |
| `crawling` | `syncDrive` when it queues `init`. `initializeSyncState` when the init runs.                         | An init is queued or running, or the folder crawl it started is. |
| `syncing`  | `runIncrementalSync` when it starts.                                                                 | An incremental sync is applying changes.                         |
| `error`    | `runIncrementalSync` when it throws.                                                                 | The last incremental sync failed. The next tick retries.         |

Nothing sets a status when the folder crawl finishes. The crawl does not track
its pending folders, so `crawling` after the init means only that the init ran.
The next incremental sync overwrites it.

### When `init` may be queued

`syncDrive` queues `init` only when all of these hold:

1. The drive is in `DRIVES`.
2. The drive has no `page_token`, so there is nothing to sync incrementally.
3. No fresh init is in flight: the row is absent, or its status is not
   `crawling`, or `crawl_requested_at` is missing or at least one hour old.

The check and the write that records the claim are one SQL statement, so
overlapping ticks and webhooks queue one `init`. An init that has not stored a
page token within the hour, because it failed or its message was lost, is queued
again. If the queue send itself fails, the claim is released and the next tick
retries.
