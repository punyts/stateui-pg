# @punyts/stateui-pg

Postgres storage for StateUI servers. It holds the pieces every database-backed server needs, and Magnetic uses it:

- `createDatabase({ url })`: one `pg` pool, `query`, and `transaction(work, { workspaceIds })`, which sets
  `app.workspace_ids` for the transaction so row-level security shows only those workspaces' rows.
- `migrate(db, sets)`, `pendingMigrations` and `assertMigrated`: numbered SQL files (`0001_name.sql`), one folder per
  owner, each applied in its own transaction and recorded in `schema_migration`. An advisory lock keeps two servers from
  migrating at once. Plain Node, so it runs from cmd, PowerShell and bash.
- `STATEUI_PG_MIGRATIONS`: this library's own tables (`migrations/`).
- `@punyts/stateui-pg/testing`: `createTestDatabase(sets)` makes a schema of its own in the test database, with the
  migrations applied, and drops it after. The test database is `PUNYTS_TEST_DATABASE_URL`, or the one `npm run
  magnetic:db` starts in Docker (`postgres://magnetic:magnetic@127.0.0.1:5433/magnetic`).

The design is `docs/design/magnetic-postgres.md` in the workspace. Postgres 16 or later with the `vector` extension
(`pgvector/pgvector:pg16`).

## Develop

```bash
npm run build
npm test        # needs the test database (above)
```
