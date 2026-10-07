# Folder passwords

A folder, or a drive root, can require a password. A visitor who opens it, or
anything under it, sees a password form. A correct password sets a cookie that
unlocks that folder for 24 hours.

## Set a password

[scripts/set-password.ts](../scripts/set-password.ts) hashes a password with
PBKDF2 and stores the hash in KV. It reads `DRIVES` from `.env`, which Bun
loads, and exits when the drive is not in it. The logic is in
[scripts/store-password.ts](../scripts/store-password.ts).

Locally, it writes the KV that `vp dev` serves, in `.void`:

```sh
bun scripts/set-password.ts --drive 0 --password secret123
bun scripts/set-password.ts --drive 0 --folder-id 1BxiMVs0XRA5nFMdKvBd --password secret123
```

For a deployed app, add `--remote` and the id of the production `KV` namespace.
The script then runs `wrangler kv key put` for you:

```sh
bun scripts/set-password.ts --drive 0 --password secret123 --remote --namespace-id <id>
```

```text
KV key:  passwd:0:root
Stored in local KV.
```

The script exits without writing on any argument it does not know, on a flag
given twice, and on a flag without a value.

- `--drive` is required. It is the drive's index in
  [`DRIVES`](configuration.md#drive-index), a plain integer. The script exits
  without writing when it is missing or malformed.
- `--folder-id` is the Google Drive folder ID. It defaults to the drive's
  `rootId`, so without it the password locks the whole drive.
- `--persist-to` is the local KV directory. It defaults to `.void` and cannot be
  combined with `--remote`.
- `--namespace-id` needs `--remote`. Without it the script would write the local
  KV and ignore the namespace, so it exits instead.

The key is `passwd:<drive index>:<folder ID>`. The app matches the key against
the IDs of every folder on the requested path, starting at the drive's `rootId`.
A password on a folder therefore covers everything below it. A My Drive root
configured as `root` uses the key `passwd:<drive index>:root`.

Delete the key to remove the password:

```sh
wrangler kv key delete --binding KV --local --persist-to .void "passwd:0:root"
```

## Unlock

[pages/[...path].server.ts](../pages/[...path].server.ts) returns the password
form for the first locked folder on the path that the visitor has not unlocked.
The form posts to `POST /api/unlock`
([routes/api/unlock.ts](../routes/api/unlock.ts)):

```json
{ "driveIdx": 0, "folderId": "root", "password": "secret123" }
```

| Status | Meaning                                      |
| ------ | -------------------------------------------- |
| 200    | Correct. Sets the `drive_unlock` cookie.     |
| 400    | The body is not JSON, or a field is missing. |
| 401    | Wrong password.                              |
| 404    | No password is set for that folder.          |

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
