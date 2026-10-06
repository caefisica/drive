# Architecture

One Cloudflare Worker, built with Void. It serves Vue pages, a small JSON and
HTML API, a cron job and a queue consumer. Google Drive is the source of files.
D1 holds searchable metadata. KV holds caches and folder password hashes.

```text
browser ── pages/ ─────────────┐
        ── routes/api/* ───────┤
                               ├── src/integrations/google-drive.ts ── Google Drive
cron ── crons/sync.ts ─────────┤
Drive ── routes/api/webhook ───┤── src/services/drive-sync.ts ── D1
queue ── queues/crawl.ts ──────┘
```

## Code map

| Path                                  | Responsibility                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ts`, `src/bindings.d.ts`         | The four environment variables and their types.                                                                                          |
| `src/config.ts`                       | Parses `DRIVES` into `DriveConfig`. A drive's index is its position.                                                                     |
| `src/integrations/google-drive.ts`    | Every Google API call: tokens, listing, path lookup, changes, file kinds. KV caches sit here.                                            |
| `src/services/crypto.ts`              | HMAC signing of stream tokens and unlock cookies, PBKDF2 passwords.                                                                      |
| `src/services/folder-access.ts`       | The `passwd:` key, the unlock cookie, and the lock checks shared by the page loader, `/api/unlock` and search.                           |
| `src/services/drive-sync.ts`          | Writes `drive_items` and `sync_state`: `syncDrive`, incremental sync, folder crawl, browse backfill.                                     |
| `db/schema.ts`, `db/migrations/`      | The D1 schema and its migrations.                                                                                                        |
| `pages/index.*`, `pages/[...path].*`  | Home and every `/<drive>/<path>` URL. The `.server.ts` loader resolves the path, checks passwords, and returns a directory or file view. |
| `pages/layout.vue`, `src/components/` | Page chrome, search box, and the viewers.                                                                                                |
| `routes/api/stream/[fileId].ts`       | Proxies file bytes from Drive, forwarding `Range`.                                                                                       |
| `routes/api/export/[fileId].ts`       | Exports a Google Docs, Sheets, Slides or Drawing file.                                                                                   |
| `routes/api/search.ts`                | Name search over `drive_items`, minus folders the visitor has not unlocked.                                                              |
| `routes/api/unlock.ts`                | Verifies a folder password and sets the unlock cookie.                                                                                   |
| `routes/api/webhook/[driveIdx].ts`    | Receives Drive change notifications and calls `syncDrive`.                                                                               |
| `crons/sync.ts`                       | Calls `syncDrive` for every drive every 15 minutes.                                                                                      |
| `queues/crawl.ts`                     | Full crawl of a drive, one folder per message.                                                                                           |
| `scripts/set-password.ts`             | Offline helper that hashes a folder password.                                                                                            |

## Viewing a path

`pages/[...path].server.ts` splits the URL into a drive index and folder names,
then walks the names to Drive folder IDs with `resolvePath`. It looks up
`passwd:<drive>:<folder>` in KV for every folder on the walk. If one has a hash
and the `drive_unlock` cookie does not cover it, it returns the password form.
Otherwise it lists a folder, or reads a file's metadata and signs a stream
token.

File bytes reach the browser through `/api/stream/<fileId>?d=<drive>&t=<token>`,
which verifies the token and fetches the bytes with the drive's access token.
Access tokens are cached in KV.

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

Opening a folder in `pages/[...path].server.ts` also calls `backfillD1Items`,
which inserts rows the index does not have yet. [Sync](docs/sync.md) covers the
behavior of each path.

## Boundaries

- Token refresh, listing, path lookup and the change feed live in
  `src/integrations/google-drive.ts`. The stream and export routes and the page
  loader's text preview fetch file content from Drive themselves, with a token
  from `getAccessToken`.
- Only `src/services/drive-sync.ts` writes `drive_items`. `routes/api/search.ts`
  only reads it.
- Signing, verifying and password hashing live in `src/services/crypto.ts`.
- D1 batches stay under D1's 100 bound parameters per statement: `drive-sync.ts`
  splits multi-row inserts by column count.
