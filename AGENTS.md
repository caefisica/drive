# AGENTS.md

Code map: [architecture.md](docs/architecture.md). Workflows:
[docs/](docs/README.md).

- Run `bun run check` before finishing. It builds first, so `.void/` exists in a
  fresh clone.
- Package manager is bun. Do not add another lockfile.
- A schema change in `db/schema.ts` ships with a migration from
  `bun run db:generate`.
- Never commit `.env` or real Google credentials.
- `bun run fix` formats Markdown at 80 columns, wrapped.
