# Configuration

The app reads four variables, declared in [env.ts](../env.ts). For local
development put them in `.env`, the only dotenv file Void reads. For production
see [Deploying](deploying.md).

| Variable         | Required | Purpose                                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `DRIVES`         | yes      | JSON array of drives to serve.                                                              |
| `STREAM_SECRET`  | yes      | HMAC key for stream and export links. See [signed links](folder-passwords.md#signed-links). |
| `UNLOCK_SECRET`  | yes      | HMAC key for the folder-unlock cookie. See [unlock](folder-passwords.md#unlock).            |
| `WEBHOOK_SECRET` | no       | Token Google sends to `/api/webhook/<index>`. See [webhook](sync.md#webhook).               |

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
index. Pages, `/api/stream`, `/api/export` and the webhook accept only a plain
non-negative integer, with no sign, leading zero or fraction. A page URL with
another form is not found, and the API routes answer 400. Append new drives.
Reordering or removing one points existing URLs, rows and passwords at a
different drive.

If `DRIVES` is not valid JSON the app behaves as if no drive is configured and
the home page says so.
