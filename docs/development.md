# Development

## Setup

```sh
mise install          # installs the vp version pinned in mise.toml
bun install           # also runs `vp config`, which installs the git hook
cp .env.example .env.local
vp dev
```

`.env.local` needs `DRIVES`, `STREAM_SECRET` and `UNLOCK_SECRET`; see
[Configuration](configuration.md). `vp dev` applies the D1 migrations to a local
database and serves on the port it prints.

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

[architecture.md](../architecture.md) describes how they fit together.

## Checks

```sh
vp check        # format, lint and type-check
vp test run     # vitest
```

`vp check` type-checks against `.void/tsconfig.json`, which Void generates. Run
`vp dev` or `vp build` once in a fresh clone before the first check.

The pre-commit hook runs `vp staged`, which runs `vp check --fix` on staged
files ([vite.config.ts](../vite.config.ts)).

The tests in
[src/services/drive-sync.test.ts](../src/services/drive-sync.test.ts) and
[routes/api/_search.test.ts](../routes/api/_search.test.ts) run against a local
D1 database with the migrations applied. The sync tests mock the Drive client
and the queue. The
[scripts/set-password.test.ts](../scripts/set-password.test.ts) tests run the
script with Bun.

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
