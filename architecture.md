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
| `src/integrations/google-drive.ts`    | Every Google API call: tokens, listing, path lookup, changes, file kinds. [KV keys](#kv-keys) sit here.                                  |
| `src/url-names.ts`                    | The one rule that turns a file's name into its URL name, and back. [URL names](#url-names) describes it.                                 |
| `src/services/item-urls.ts`           | Derives the URL of indexed files from their chain of parents, for search.                                                                |
| `src/test-support/fake-drive.ts`      | An in-memory Google Drive for tests: listing, lookup and the change feed, with renames, moves and request delays.                        |
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
| `scripts/set-password.ts`             | CLI that hashes a folder password and stores it in KV through `scripts/store-password.ts`.                                               |

## Viewing a path

`pages/[...path].server.ts` splits the URL into a drive index and folder names,
then walks the names to Drive folder IDs with `resolvePath`. It looks up
`passwd:<drive>:<folder>` in KV for every folder on the walk. If one has a hash
and the `drive_unlock` cookie does not cover it, it returns the password form.
Otherwise it lists a folder, or reads a file's metadata and signs a stream
token.

The loader's props reach the browser as JSON, so they carry only each drive's
`idx`, `name` and `kind`, never its credentials.

File bytes reach the browser through `/api/stream/<fileId>?d=<drive>&t=<token>`,
which verifies the token and fetches the bytes with the drive's access token.
`d` must be a non-negative integer, or the route answers 400. Access tokens are
cached in KV.

## URL names

A URL is a drive index and one URL name per folder on the way down. The rule is
in `src/url-names.ts`, and every listing and lookup goes through it:

- A file whose name no sibling shares is its own URL name.
- A file that shares its name with a sibling in the same folder, or whose name
  already looks like a suffixed one, gets its Drive file ID appended:
  `name (dupID: <id>)`.

Distinct files of a folder therefore never share a URL name. A suffixed segment
names the file whose ID it carries, and a plain segment names a file only when
exactly one sibling has that name, so a plain name two files share is a 404.

`listDirectory` reads a whole folder, every page, because whether a name is
shared depends on every other file of the folder. The home page, folder pages
and the crawl all list through it. `resolveSegment` is the lookup for the same
rule. Search derives each result's link with `itemUrls`, which reads the chain
of parents from `drive_items` up to the drive's root, resolved to the real ID
with `resolveFolderId`, and applies the same rule. A file whose chain does not
reach the root, because a folder on the way is not indexed, links to the drive.

### What the index stores

A `drive_items` row holds only what Drive says about one file: its ID, parent,
raw name, kind, size and modification time. No row holds a URL, a path or a
suffix. The path of a file below a folder that was renamed or moved is correct
the moment that folder's row changes.

### Concurrency rule

Four writers touch `drive_items`: the cron, the webhook, the crawl queue and the
backfill after browsing a folder. Each writes every row as a function of one
file, takes nothing from any other row, and computes no URL. Whichever order
they interleave in, no two files get the same URL name and no file gets another
file's URL.

Upserts from the crawl and the change feed replace a row only with data whose
modified time is not older than the row's, so a listing read before a change
cannot undo it. A listing and a change that carry the same modified time, such
as a move, are applied in arrival order. The change feed repairs a row left
behind that way: the next change to the file carries a modified time at least as
new, so it always applies.

One single-row case has no owner that repairs it. A listing read before a file
was removed can recreate the row after the feed deleted it, because nothing
records that a row was deleted, and the crawl only adds and updates rows. The
row stays in search until the operator deletes it from `drive_items`, and its
link leads to a page that Drive no longer backs. It changes only what that one
file shows. Browsing never reads the index, so it is exact at the moment it
lists.

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

## KV keys

Every key carries the drive index, so reordering `DRIVES` points each key at
another drive. Tokens, listings and metadata are caches that rebuild themselves.
Name lookups are not cached, so a URL always resolves against the folder as it
is now. The two keys that do not expire are `passwd:` and `rootid:`.

| Key                       | Value                                | Written by                                                        | Ends when                                                                      |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `auth:<drive>:token`      | Access token and its expiry          | `getAccessToken` on a miss                                        | Expires a minute before Google's token does.                                   |
| `dir:<drive>:<folder>`    | A whole folder listing, URL names    | `listDirectory` on a miss                                         | Expires after 5 minutes.                                                       |
| `meta:<drive>:<file>`     | A file's metadata                    | `getFileMetadata` on a miss                                       | Expires after 1 hour. A sync that changes or removes the file deletes it.      |
| `passwd:<drive>:<folder>` | The PBKDF2 hash of a folder password | `scripts/set-password.ts`                                         | Never. The operator deletes it ([folder passwords](docs/folder-passwords.md)). |
| `rootid:<drive>`          | The real ID of a My Drive root       | `resolveFolderId` on a miss, for a drive whose `rootId` is `root` | Never. See below.                                                              |

`rootid:<drive>` exists because Google reports a My Drive's real root ID, not
the `root` alias, as the parent of its top-level files, and `drive_items` rows
match on the real ID. A crawl `init`, every folder browse and every search that
links a result call `resolveFolderId`. The first call after a miss asks Google
for `files/root` and writes the key. Later calls only read it. Two callers that
race on a miss both write the same value. A key is absent until its first use,
then present for good. A My Drive root ID never changes, so nothing expires it.
It is wrong only when the refresh token at that drive index is replaced by a
token for a different account. The operator then deletes the key, and the next
call writes the new ID. Rows already indexed under the old root ID are stale in
that case, so the drive needs a new crawl as well. Drives with another `rootId`
never write the key.

## Boundaries

- Token refresh, listing, path lookup and the change feed live in
  `src/integrations/google-drive.ts`. The stream and export routes and the page
  loader's text preview fetch file content from Drive themselves, with a token
  from `getAccessToken`.
- Only `src/services/drive-sync.ts` writes `drive_items`, and only each file's
  own fields. `routes/api/search.ts` only reads it.
- Signing, verifying and password hashing live in `src/services/crypto.ts`.
- D1 batches stay under D1's 100 bound parameters per statement: `drive-sync.ts`
  splits multi-row inserts by column count.
