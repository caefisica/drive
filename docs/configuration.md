# Configuration

The app reads four variables, declared in [env.ts](../env.ts). For local
development put them in `.env`, the only dotenv file Void reads. For production
see [Deploying](deploying.md).

| Variable         | Required | Purpose                                           |
| ---------------- | -------- | ------------------------------------------------- |
| `DRIVES`         | yes      | JSON array of drives to serve.                    |
| `STREAM_SECRET`  | yes      | HMAC key for stream and export links. 1 h expiry. |
| `UNLOCK_SECRET`  | yes      | HMAC key for the folder-unlock cookie. 24 h.      |
| `WEBHOOK_SECRET` | no       | Token Google sends to `/api/webhook/<index>`.     |

Generate each secret with `openssl rand -base64 32`. A `.env` looks like this:

```sh
DRIVES='[{"name":"My Drive","kind":"my_drive","rootId":"root","clientId":"…","clientSecret":"…","refreshToken":"…"}]'
STREAM_SECRET=<openssl rand -base64 32>
UNLOCK_SECRET=<openssl rand -base64 32>
# WEBHOOK_SECRET=<openssl rand -base64 32>
```

## DRIVES

`DRIVES` is a JSON array. Each entry describes one drive. The type is
`DriveConfig` in [src/config.ts](../src/config.ts).

```json
[
  {
    "name": "My Drive",
    "kind": "my_drive",
    "rootId": "root",
    "clientId": "…apps.googleusercontent.com",
    "clientSecret": "…",
    "refreshToken": "…"
  },
  {
    "name": "Physics Dept",
    "kind": "shared_drive",
    "rootId": "<shared drive id>",
    "clientId": "…",
    "clientSecret": "…",
    "refreshToken": "…"
  },
  {
    "name": "Shared Docs",
    "kind": "folder",
    "rootId": "<folder id>",
    "clientId": "…",
    "clientSecret": "…",
    "refreshToken": "…"
  }
]
```

| Field          | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `name`         | Label on the drive tab and in search results.              |
| `kind`         | `my_drive` (default), `shared_drive` or `folder`.          |
| `rootId`       | The folder the drive starts at. Depends on `kind`.         |
| `clientId`     | OAuth client ID from Google Cloud.                         |
| `clientSecret` | OAuth client secret.                                       |
| `refreshToken` | Refresh token for a Google account that can read the root. |

`kind` selects how `rootId` is read:

| `kind`         | `rootId`                                                   |
| -------------- | ---------------------------------------------------------- |
| `my_drive`     | `root`, or the ID of any folder in your own Drive.         |
| `shared_drive` | The ID of the shared (Team) drive itself, not a folder.    |
| `folder`       | The ID of a folder someone shared with the Google account. |

For a `shared_drive`, listing, change and start-token requests carry the drive
ID, so Google scopes them to that drive
([src/integrations/google-drive.ts](../src/integrations/google-drive.ts)).

The app only reads from Drive. Authorize the refresh token with a read-only
scope such as `https://www.googleapis.com/auth/drive.readonly`.

### Drive index

A drive's position in the array is its index. URLs (`/0/…`), the `d` parameter
of the API routes, the webhook path, and the rows in D1 and KV all use that
index. `/api/stream` and `/api/export` answer 400 unless `d` is a plain
non-negative integer, with no sign, leading zero or fraction. Append new drives.
Reordering or removing one points existing URLs, rows and passwords at a
different drive.

If `DRIVES` is not valid JSON the app behaves as if no drive is configured and
the home page says so.

### Listing behavior

- A shortcut appears as its target.
- Files with the same name in one folder get their Drive file ID as a suffix,
  `name (dupID: 1AbC)`, so each has its own URL. The plain name of such files is
  not a URL: it answers 404.
- A file named `.password` is not listed.
- A folder is listed whole, every page, so a shared name is always found.
- Folder listings are cached in KV for 5 minutes and file metadata for 1 hour. A
  URL is resolved against the folder as it is, never from a cache.
