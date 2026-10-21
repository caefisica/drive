# Sync

Folder pages and search read the `drive_items` table in D1
([db/schema.ts](../db/schema.ts)). Two paths write to it. Both use
[src/services/drive-sync.ts](../src/services/drive-sync.ts). The `sync_state`
table holds one row per drive; [Architecture](architecture.md#sync_state)
describes its columns and statuses.

| Path        | Trigger                        | Writes                                  |
| ----------- | ------------------------------ | --------------------------------------- |
| Crawl queue | A message on the `crawl` queue | Rows for every folder of a drive.       |
| Incremental | Cron, or a Drive webhook       | Files that changed since the last sync. |

The rows hold no URL. See
[what the index stores](architecture.md#what-the-index-stores). The paths may
run concurrently. The [concurrency rule](architecture.md#concurrency-rule)
describes how they avoid conflicting writes.

A new drive needs no setup. The first cron tick or webhook for it queues a crawl
that indexes every folder, and later ticks apply only what changed. Until the
crawl has read every folder, the drive's home and folder pages answer 503 with
the message "not indexed yet". Visitors who reload a few minutes later see the
drive.

## Crawl queue

[queues/crawl.ts](../queues/crawl.ts) consumes the `crawl` queue one message at
a time and retries a failed message 3 times. It handles two message bodies:

```json
{ "type": "init", "driveIdx": 0 }
{ "type": "folder", "driveIdx": 0, "folderId": "…" }
```

- `init` stores Drive's current change token in `sync_state` and clears
  `crawled_at`, then enqueues a `folder` message for the drive's root. It looks
  the root up first, so a My Drive configured as `root` starts at its real ID
  ([`rootid:` key](architecture.md#kv-keys)).
- `folder` reads the drive's `feed_seq`, lists the folder from Drive, upserts
  every item except rows the change feed stamped after that read, and enqueues a
  `folder` message for each subfolder. It keeps the list of folders still to
  read, and sets `crawled_at` when that list is empty.

`syncDrive` queues `init` for a drive that has no change token. The
[conditions](architecture.md#when-init-may-be-queued) keep overlapping ticks and
webhooks from queuing it twice and let a lost `init` be queued again.

A folder message that fails 3 times is dropped, and its drive keeps answering
503 because the crawl never empties its list. Crawl the drive again by clearing
its change token. The next cron tick queues `init`. `0` is the drive's index:

```sh
vp exec void db execute --remote "UPDATE sync_state SET page_token = NULL WHERE drive_idx = 0"
```

## Incremental sync

`syncDrive(driveIdx, env)` is what the cron job and the webhook call. When the
drive has a stored token it runs `runIncrementalSync`, which reads Drive's
change feed from that token page by page. For each change it deletes the row of
a removed or trashed file, and inserts or updates the row of any other file with
its name and parent as Drive reports them. A renamed or moved folder is one row
change, and the URLs below it follow. Each page is one D1 batch that first bumps
the drive's `feed_seq` and stamps the rows it writes with the new value (see the
[concurrency rule](architecture.md#concurrency-rule)). After the last page it
stores the new token and sets the status to `idle`. On an error it sets the
status to `error` and rethrows, and the next tick tries again.

### Cron

[crons/sync.ts](../crons/sync.ts) runs every 15 minutes (`*/15 * * * *`). It
calls `syncDrive` for every configured drive in parallel and logs the drives
that fail.

### Webhook

`POST /api/webhook/<driveIdx>` calls `syncDrive` right away
([routes/api/webhook/[driveIdx].ts](../routes/api/webhook/[driveIdx].ts)). It
answers 403 unless the `X-Goog-Channel-Token` header equals `WEBHOOK_SECRET`,
compared in constant time, so the route is off while that variable is unset. It
answers 400 when the drive index is not a plain non-negative integer. Otherwise
it answers 200 and syncs after the response.

The app does not register the watch. Register it once per drive with the Drive
API, using an access token for that drive. `token` must equal `WEBHOOK_SECRET`:

```sh
curl -X POST \
  "https://www.googleapis.com/drive/v3/changes/watch?pageToken=<token>&supportsAllDrives=true" \
  -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<unique channel id>",
    "type": "web_hook",
    "address": "https://<your host>/api/webhook/0",
    "token": "<WEBHOOK_SECRET>"
  }'
```

Get `<token>` from `changes/startPageToken`. Add `driveId=<id>` to both calls
for a `shared_drive`. A watch channel expires, and the app does not renew it.
The cron job keeps the index current when a channel lapses.
