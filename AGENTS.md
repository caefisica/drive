# AGENTS.md

Code map: [architecture.md](docs/architecture.md). Workflows:
[docs/](docs/README.md).

- Run `vp check` and `vp test run` before finishing. Run `vp dev` or `vp build`
  first in a fresh clone so `.void/` exists.
- Package manager is bun. Do not add another lockfile.
- A schema change in `db/schema.ts` ships with a migration from
  `vp exec void db generate`.
- Never commit `.env` or real Google credentials.
- `vp check --fix` formats Markdown at 80 columns, wrapped.
