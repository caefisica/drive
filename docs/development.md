# Development

## Setup

```sh
mise install          # installs the vp version pinned in mise.toml
bun install           # also runs `vp config`, which installs the git hook
vp dev
```

Bun is not pinned in `mise.toml`. Install the version `package.json` names in
`packageManager`.

`.env` needs `DRIVES`, `STREAM_SECRET` and `UNLOCK_SECRET`. Void reads no other
dotenv file. See [Configuration](configuration.md). `vp dev` applies the D1
migrations to a local database and serves on the port it prints.

## Layout

| Path       | Holds                                                               |
| ---------- | ------------------------------------------------------------------- |
| `pages/`   | Vue pages with a `.server.ts` loader each.                          |
| `routes/`  | HTTP handlers under `/api`.                                         |
| `crons/`   | Scheduled jobs.                                                     |
| `queues/`  | Queue consumers.                                                    |
| `src/`     | Config parsing, the Drive client, sync, crypto, and Vue components. |
| `db/`      | Drizzle schema and SQL migrations.                                  |
| `scripts/` | Operator scripts run with Bun.                                      |

[Architecture](architecture.md) describes how they fit together.

## Checks

```sh
vp check        # format, lint and type-check
vp test run     # vitest
```

`vp check` type-checks against `.void/tsconfig.json`, which Void generates. Run
`vp dev` or `vp build` once in a fresh clone before the first check.

The pre-commit hook runs `vp staged`, which runs `vp check --fix` on staged
files ([vite.config.ts](../vite.config.ts)).

Tests sit next to the code as `*.test.ts`. Files in `routes/` start with `_` so
Void does not serve them as routes. Most run against a local D1 database and KV
that Wrangler provides, with the migrations applied. The Drive is either mocked
or the in-memory [fake Drive](../src/test-support/fake-drive.ts).
[src/index-urls.test.ts](../src/index-urls.test.ts) runs the crawl consumer, the
cron, the webhook, the page loaders and search together against the fake Drive,
with the writers interleaved.
[scripts/set-password.test.ts](../scripts/set-password.test.ts) runs the script
itself, so `bun` must be on the `PATH`.

## Database changes

Edit [db/schema.ts](../db/schema.ts), then generate a migration:

```sh
vp exec void db generate
```

Commit the new SQL file and its `meta` snapshot with the schema change.

## Documentation

Format Markdown with Prettier at 80 columns:

```sh
bunx prettier --print-width 80 --prose-wrap always --write '**/*.md'
```
