# Architecture

One Cloudflare Worker, built with Void. It serves Vue pages, a small JSON and
HTML API, a cron job and a queue consumer. Google Drive is the source of files.
D1 holds the index of every file, which pages and search read. KV holds access
tokens, folder password hashes and My Drive root IDs. Only the crawl and the
change feed read Google's folder listings.

```text
browser ── pages/ ─────────────── src/services/listing.ts ── D1
        ── routes/api/* ───────┘

cron ── crons/sync.ts ─────────┐
Drive ── routes/api/webhook ───┤── src/services/drive-sync.ts ── D1
queue ── queues/crawl.ts ──────┘          │
                                          └── src/integrations/google-drive.ts ── Google Drive
```

## Code map

| Path                                  | Responsibility                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ts`, `src/bindings.d.ts`         | The four environment variables and their types.                                                                                                                                                                                                                                                            |
| `src/config.ts`                       | Parses `DRIVES` into `DriveConfig`. A drive's index is its position.                                                                                                                                                                                                                                       |
| `src/integrations/google-drive.ts`    | Google API calls for tokens, the crawl's folder listing, the root ID and changes, plus file kinds. File bytes are fetched elsewhere: `routes/api/stream/[fileId].ts` (stream), `routes/api/export/[fileId].ts` (export) and the text preview in `pages/[...path].server.ts`. [KV keys](#kv-keys) sit here. |
| `src/services/listing.ts`             | Reads `drive_items` for pages: whether a drive's crawl is done, a folder's listing in Drive's order, and the walk from URL names to a file.                                                                                                                                                                |
| `src/url-names.ts`                    | The one rule that turns a file's name into its URL name, and back. [URL names](#url-names) describes the code path.                                                                                                                                                                                        |
| `src/services/item-urls.ts`           | Derives the URL of indexed files from their chain of parents, for search, with every segment named by ID.                                                                                                                                                                                                  |
| `src/test-support/fake-drive.ts`      | An in-memory Google Drive for tests: listing, lookup and the change feed, with renames, moves and request delays.                                                                                                                                                                                          |
| `src/services/crypto.ts`              | HMAC signing of stream tokens and unlock cookies, PBKDF2 passwords.                                                                                                                                                                                                                                        |
| `src/services/folder-access.ts`       | The `passwd:` key, the unlock cookie, and the lock checks shared by the page loader, `/api/unlock` and search.                                                                                                                                                                                             |
| `src/services/drive-sync.ts`          | Writes `drive_items`, `drive_removals`, `crawl_pending` and `sync_state`: `syncDrive`, incremental sync, folder crawl.                                                                                                                                                                                     |
| `db/schema.ts`, `db/migrations/`      | The D1 schema and its migrations.                                                                                                                                                                                                                                                                          |
| `pages/index.*`, `pages/[...path].*`  | Home and every `/<drive>/<path>` URL. The `.server.ts` loader resolves the path in D1, checks passwords, and returns a directory or file view.                                                                                                                                                             |
| `pages/layout.vue`, `src/components/` | Page chrome, search box, and the viewers.                                                                                                                                                                                                                                                                  |
| `routes/api/stream/[fileId].ts`       | Proxies file bytes from Drive, forwarding `Range`.                                                                                                                                                                                                                                                         |
| `routes/api/export/[fileId].ts`       | Exports a Google Docs, Sheets, Slides or Drawing file.                                                                                                                                                                                                                                                     |
| `routes/api/search.ts`                | Name search over `drive_items`, minus the contents of folders the visitor has not unlocked.                                                                                                                                                                                                                |
| `routes/api/unlock.ts`                | Verifies a folder password and sets the unlock cookie.                                                                                                                                                                                                                                                     |
| `routes/api/webhook/[driveIdx].ts`    | Receives Drive change notifications and calls `syncDrive`.                                                                                                                                                                                                                                                 |
| `crons/sync.ts`                       | Calls `syncDrive` for every drive on a schedule.                                                                                                                                                                                                                                                           |
| `queues/crawl.ts`                     | Full crawl of a drive, one folder per message.                                                                                                                                                                                                                                                             |
| `scripts/set-password.ts`             | CLI that hashes a folder password and stores it in KV through `scripts/store-password.ts`.                                                                                                                                                                                                                 |

## Viewing a path

`pages/[...path].server.ts` splits the URL into a drive index and folder names.
It answers 503 while the drive's crawl is unfinished (`crawledRoot`). Then it
walks the names to Drive folder IDs with `resolvePath`, which reads
`drive_items`. It looks up `passwd:<drive>:<folder>` in KV for every folder on
the walk. If one has a hash and the `drive_unlock` cookie does not cover it, it
returns the password form. Otherwise it lists a folder with `listFolder`, or
takes a file's metadata from its index row and signs a stream token. A URL that
ends in `/` is a folder. A page never reads or writes a folder listing in KV and
never asks Google for one.

The loader's props reach the browser as JSON, so they carry only each drive's
`idx`, `name` and `kind`, never its credentials.

File bytes reach the browser through `/api/stream/<fileId>?d=<drive>&t=<token>`,
which verifies the token and fetches the bytes with the drive's access token.
`d` must be a non-negative integer, or the route answers 400.

## URL names

A URL is a drive index and one URL name per folder on the way down.
[Browsing](browsing.md#duplicate-names) states the rule. The code applies it in
one place, `src/url-names.ts`, and every listing and lookup goes through it:

- `listFolder` reads a whole folder from `drive_items`, because whether a name
  is shared depends on every other file of the folder. The home page and folder
  pages list through it. It orders folders first, then names without regard to
  case, then the newest file.
- `resolvePath` is the lookup for the same rule. It reads the siblings of each
  name, so a URL and the listing that produced it agree.
- Search derives each result's link with `itemUrls`. It reads the chain of
  parents from `drive_items` up to the drive's root, read with `getRootId`. The
  index may lack a twin that Drive holds, so search cannot apply the sharing
  rule. It writes every segment in the suffixed form, which `resolvePath`
  resolves by ID whatever the siblings are. A file whose chain does not reach
  the root, because a folder on the way is not indexed, links to the drive.

### What the index stores

A `drive_items` row holds only what Drive says about one file: its ID, parent,
raw name, kind, size and modification time. No row holds a URL, a path or a
suffix. The path of a file below a folder that was renamed or moved is correct
the moment that folder's row changes.

A shortcut has a row of its own. Its `mime_type` is its target's, and
`shortcut_target_id` holds the target's ID. A listing shows the shortcut as its
target and links to it by its own name. Opening it shows the target's content,
and a shortcut to a folder lists the target's files. The crawl does not follow a
shortcut, so a target outside the drive's tree lists nothing unless the crawl
reaches it through its own parents.

### Concurrency rule

Three writers touch `drive_items`: the cron, the webhook and the crawl queue.
The cron and the webhook both run the change feed. Each inserts or updates a row
as a function of one file, takes nothing from any other row, and computes no
URL. Only the feed and the crawl delete rows, as set out below. Whichever order
they interleave in, no two files get the same URL name and no file gets another
file's URL.

The change feed always replaces the row it writes. Drive has no version that a
move bumps, and a move leaves the modified time as it was, so the order of
writes is kept locally. Each batch of the feed takes the next number of its
drive's `sync_state.feed_seq` and stamps the rows it writes with it
(`drive_items.feed_seq`). A crawl reads `feed_seq` before it lists the folder,
and its upsert replaces a row only if the row's stamp is null or no greater than
that number. A listing read before a change therefore cannot undo it, however
late the crawl writes it, and a move wins without comparing times. A listing
that a row refused is not lost: any change newer than it is still ahead in the
feed, which is read from a token taken before the crawl.

A crawl of a folder deletes two sets of rows of its drive:

- Rows whose parent is the crawled folder and whose ID the listing lacks, unless
  the feed stamped the row after the counter was read.
- Rows, in any folder, that `drive_removals` holds with a batch number above the
  counter it read. The feed records each file it removes there for one hour, so
  a stale listing cannot write a deleted file back. A later change to the file
  clears its record.

The feed also deletes a row whose file is now named `.password`, and writes no
row for such a file, because listings and search hide it.

A folder page shows a change once the feed has applied it: at the next cron tick
(every 15 minutes), or at once when a webhook arrives.

## Indexing

Each configured drive has one `sync_state` row. A drive is indexed in two
phases: an initial crawl that walks every folder, then incremental syncs that
apply Google's change feed from a stored page token.

`syncDrive` (`src/services/drive-sync.ts`) is the entry point for both. The cron
(`crons/sync.ts`) and the webhook (`routes/api/webhook/[driveIdx].ts`) call it.
It runs an incremental sync when the drive has a page token. Otherwise it queues
the crawl `init` message that starts the initial crawl. [Sync](sync.md) covers
the behavior of each path.

## sync_state

| Column               | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `page_token`         | Cursor into the change feed. Null until an init has run.           |
| `last_synced_at`     | When the page token was last stored.                               |
| `crawl_requested_at` | When `init` was queued. Cleared when the init stores a page token. |
| `feed_seq`           | Counts the change-feed batches written. See the concurrency rule.  |
| `crawled_at`         | When the crawl read its last folder. Null until it has.            |
| `status`             | One of the values below.                                           |

`crawled_at` decides what a page does. While it is null, home and folder pages
answer 503 with a message, because the index is partial. The crawl keeps one
`crawl_pending` row per folder of the drive that is queued or being read. The
`init` message inserts the root. A `folder` message removes its own row and
inserts a row for each subfolder in one batch, then sets `crawled_at` in that
batch if no row is left. Starting a crawl again clears `crawled_at`, so a drive
re-crawled after a failure answers 503 until the new crawl ends.

### Statuses

| Status     | Written by                                                                                           | Meaning                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `idle`     | `runIncrementalSync` when it finishes. Column default. Reset by `syncDrive` if the queue send fails. | No work in progress.                                             |
| `crawling` | `syncDrive` when it queues `init`. `initializeSyncState` when the init runs.                         | An init is queued or running, or the folder crawl it started is. |
| `syncing`  | `runIncrementalSync` when it starts.                                                                 | An incremental sync is applying changes.                         |
| `error`    | `runIncrementalSync` when it throws.                                                                 | The last incremental sync failed. The next tick retries.         |

Nothing sets a status when the folder crawl finishes. `crawling` after the init
means only that the init ran, and the next incremental sync overwrites it.
`crawled_at` is what says the crawl is done.

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

## KV keys

Every key carries the drive index, so reordering `DRIVES` points each key at
another drive. KV holds no folder listing and no file metadata: Cloudflare
limits the puts a day, and D1 holds that data already. The token rebuilds itself
when it expires. The two keys that do not expire are `passwd:` and `rootid:`.

| Key                       | Value                                | Written by                                                      | Ends when                                                                 |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `auth:<drive>:token`      | Access token and its expiry          | `getAccessToken` on a miss                                      | Expires a minute before Google's token does.                              |
| `passwd:<drive>:<folder>` | The PBKDF2 hash of a folder password | `scripts/set-password.ts`                                       | Never. The operator deletes it ([folder passwords](folder-passwords.md)). |
| `rootid:<drive>`          | The real ID of a My Drive root       | `resolveFolderId` in the crawl `init`, for a `rootId` of `root` | Never. See below.                                                         |

A drive writes one `auth:` put each time its token has expired and a request
needs it, which is every 3,540 seconds at the most often: 25 puts a day. Several
requests that find the token expired at the same moment on different isolates
each write it. `rootid:` is written once per drive. For N drives that is 25·N
puts a day, plus N once. Pages and search write nothing.

`rootid:<drive>` exists because Google reports a My Drive's real root ID, not
the `root` alias, as the parent of its top-level files, and `drive_items` rows
match on the real ID. The crawl `init` calls `resolveFolderId`. The first call
after a miss asks Google for `files/root` and writes the key. Later calls only
read it. Pages and search read it with `getRootId`, which never asks Google, and
treat a missing key as a drive that is not crawled. Drives with another `rootId`
never write the key.

A My Drive root ID never changes, so nothing expires the key. It is wrong when
the refresh token at that drive index is replaced by a token for a different
account. Delete the key then. Rows already indexed under the old root ID are
stale.

## Boundaries

- Token refresh, the crawl's folder listing and the change feed live in
  `src/integrations/google-drive.ts`. The stream and export routes and the page
  loader's text preview fetch file content from Drive themselves, with a token
  from `getAccessToken`.
- Only `src/services/drive-sync.ts` writes `drive_items`. It inserts and updates
  only each file's own fields. `src/services/listing.ts` and
  `routes/api/search.ts` only read it.
- Signing, verifying and password hashing live in `src/services/crypto.ts`.
- D1 batches stay under D1's 100 bound parameters per statement:
  `src/services/drive-sync.ts` splits multi-row inserts by column count.
