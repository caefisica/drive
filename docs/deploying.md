# Deploying

The app deploys with the Void CLI, which [package.json](../package.json) wraps
in two scripts:

| Script                | Runs                       | Does                                  |
| --------------------- | -------------------------- | ------------------------------------- |
| `bun run release:db`  | `void db migrate --remote` | Applies `db/migrations` to remote D1. |
| `bun run release:app` | `void deploy`              | Builds and deploys the Worker.        |

Run `release:db` first. A change to [db/schema.ts](../db/schema.ts) needs a new
migration from `vp exec void db generate` before it.

## First deploy

1. Sign in and link the directory to a Void project with
   `vp exec void auth login` and `vp exec void project link`.
2. Upload the production variables. `DRIVES` holds OAuth credentials, so treat
   it as a secret:

   ```sh
   vp exec void secret sync .env.local
   ```

   See [Configuration](configuration.md) for what each variable holds.

3. Run `bun run release:db`, then `bun run release:app`.

`void deploy` registers the cron job in [crons/sync.ts](../crons/sync.ts) and
the `crawl` queue in [queues/crawl.ts](../queues/crawl.ts), and provisions the
D1 and KV bindings that [void.json](../void.json) infers.

The first cron tick after the deploy starts indexing each drive; see
[Sync](sync.md). Optionally [register the webhook](sync.md#webhook).
