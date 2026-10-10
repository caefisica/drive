# Deploying

The app deploys to your own Cloudflare account with the Void CLI, which
[package.json](../package.json) wraps in scripts:

| Script                      | Runs                       | Does                                                                       |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `bun run release:app`       | `void deploy`              | Builds, creates missing resources, applies migrations, deploys the Worker. |
| `bun run db:migrate`        | `void db migrate`          | Applies pending migrations to the local database.                          |
| `bun run db:migrate:remote` | `void db migrate --remote` | Applies pending migrations to the production database without a deploy.    |

A change to [db/schema.ts](../db/schema.ts) needs a
[new migration](development.md#database-changes) before the deploy.
`void deploy` stops when the schema has changes without one.

## First deploy

1. Choose Cloudflare as the destination and sign in. A browser window opens:

   ```sh
   vp exec void connect --platform cloudflare
   ```

2. Set the production secrets. `DRIVES` holds OAuth credentials, so it is a
   secret like the rest. Each command reads the value from stdin:

   ```sh
   vp exec void secret put DRIVES
   vp exec void secret put STREAM_SECRET
   vp exec void secret put UNLOCK_SECRET
   vp exec void secret put WEBHOOK_SECRET   # optional
   ```

   See [Configuration](configuration.md) for what each variable holds. Void
   never uploads the local `.env`. The first `void deploy` stops and lists the
   required secrets that are still unset, so you can also run it first.

3. Run `bun run release:app`, then commit the `void.lock.json` it writes. The
   app is served at `https://drive.<your workers.dev subdomain>.workers.dev`.

In CI, or any shell without a browser, set `CLOUDFLARE_API_TOKEN` (and
`CLOUDFLARE_ACCOUNT_ID`) instead of running `void connect`, and write
`{ "platform": "cloudflare" }` to `.void/project.json` so `void secret` targets
Cloudflare. If a deploy stops with "no preview URL", set
`CLOUDFLARE_WORKERS_SUBDOMAIN` to your account's workers.dev subdomain and rerun
it.

`void deploy` registers the cron job in [crons/sync.ts](../crons/sync.ts) and
the `crawl` queue in [queues/crawl.ts](../queues/crawl.ts), and creates the D1
database and KV namespace that [void.config.ts](../void.config.ts) infers. It
records their IDs in `void.lock.json`.

The first cron tick after the deploy starts indexing each drive; see
[Sync](sync.md). Optionally [register the webhook](sync.md#webhook).
