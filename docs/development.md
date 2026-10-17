# Development

## Setup

```sh
mise install          # installs the pinned Bun and Node versions
mise run install      # runs `vp config`, which installs the git hook
mise run dev
```

`.env` needs `DRIVES`, `STREAM_SECRET` and `UNLOCK_SECRET`. Void reads no other
dotenv file. See [Configuration](configuration.md). `mise run dev` applies the
D1 migrations to a local database and serves on the port it prints.

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
mise run check  # lint, typecheck, test and build; writes no tracked file
mise run fix    # apply safe lint fixes and format every file
```

`check` runs `lint`, `typecheck`, `test` and `build`, each also a task of its
own. They depend on `build`, which generates the `.void/tsconfig.json` that
type-checking reads, so a fresh clone needs no extra step.

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
mise run db:generate
```

Commit the new SQL file and its `meta` snapshot with the schema change.

## Documentation

`mise run lint` checks Markdown at 80 columns with prose wrapped, from the `fmt`
override in [vite.config.ts](../vite.config.ts). Rewrite the files with:

```sh
mise run fix
```
