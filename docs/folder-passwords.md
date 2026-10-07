# Folder passwords

A folder, or a drive root, can require a password. A visitor who opens it, or
anything under it, sees a password form. A correct password sets a cookie that
unlocks that folder for 24 hours.

## Set a password

[scripts/set-password.ts](../scripts/set-password.ts) hashes a password with
PBKDF2 and prints the KV entry to store. It reads `DRIVES` from `.env`, which
Bun loads, and exits when the drive is not in it:

```sh
bun scripts/set-password.ts --drive 0 --password secret123
bun scripts/set-password.ts --drive 0 --folder-id 1BxiMVs0XRA5nFMdKvBd --password secret123
```

```text
KV key:  passwd:0:root
KV hash: pbkdf2:PYIFguR2u9g9eYscLoegyA==:1dXg3cKW+7rfg6TrwqF/YBq5YQqHdHUv6xlxPZPcbOg=
```

- `--drive` is the drive's index in [`DRIVES`](configuration.md#drive-index). It
  defaults to `0`.
- `--folder-id` is the Google Drive folder ID. It defaults to the drive's
  `rootId`, so without it the password locks the whole drive.

The key is `passwd:<drive index>:<folder ID>`. The app matches the key against
the IDs of every folder on the requested path, starting at the drive's `rootId`.
A password on a folder therefore covers everything below it.

Store the printed hash under that key in the `KV` namespace.

Locally, with the dev server running, write it through the local explorer API at
the URL `vp dev` prints:

```sh
LOCAL=<local URL printed by vp dev>
curl -X PUT "$LOCAL/cdn-cgi/local/explorer/api/storage/kv/namespaces/local/values/passwd:0:root" \
  -H 'Content-Type: text/plain' --data '<hash>'
```

For a deployed app, write it to the production namespace with Wrangler:

```sh
wrangler kv key put --namespace-id <id> --remote "passwd:0:root" '<hash>'
```

Delete the key to remove the password.

## Unlock

[pages/[...path].server.ts](../pages/[...path].server.ts) returns the password
form for the first locked folder on the path that the visitor has not unlocked.
The form posts to `POST /api/unlock`
([routes/api/unlock.ts](../routes/api/unlock.ts)):

```json
{ "driveIdx": 0, "folderId": "root", "password": "secret123" }
```

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 200    | Correct. Sets the `drive_unlock` cookie. |
| 400    | A field is missing.                      |
| 401    | Wrong password.                          |
| 404    | No password is set for that folder.      |

The cookie is signed with `UNLOCK_SECRET`, is `HttpOnly` and `SameSite=Lax`, and
lists every folder the visitor has unlocked. Rotating `UNLOCK_SECRET` locks
everything again.

## Search

`/api/search` leaves out everything below a folder the visitor has not unlocked,
using the folder's `passwd:` key in KV and the cookie. The locked folder's own
name still appears. A drive whose root is locked returns no results. Unlocking a
folder brings its contents back into the visitor's results.

## Signed links

Stream and export links are signed for one hour. A link issued after unlocking
works for that hour without the cookie.
