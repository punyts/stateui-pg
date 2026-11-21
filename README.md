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

## Reporting

It reports to `@punyts/core`'s default reporter, off unless a host turns the categories on (`stateui-pg.*`, or
`PUNYTS_REPORT` in Magnetic and stateui-mcp). A report names statements, tables, ids, counts and durations, never SQL
parameters or an error's message (only its SQLSTATE).

| Category | Reports |
|---|---|
| `stateui-pg.migrate` | the migration lock taken (`ms` waited), how many are pending, a migration applied or failed (`owner`, `version`, `name`, `ms`) |
| `stateui-pg.query` | a query: `statement` (`SELECT`, `INSERT`, ...), its first `table`, `rows`, `ms`, `inTransaction`; a failed one with its `code` |
| `stateui-pg.transaction` | a transaction begun, committed (`queries`, `ms`) or rolled back (`code`), with its `workspaceIds` |
| `stateui-pg.lock` | an advisory lock held: the key's kind (`files`, `errors`) and the `ms` waited |
| `stateui-pg.changes` | listening to part changes, a change heard (`workspaceId`, `kind`, `name`), the connection lost and listening again |

## Develop

```bash
npm run build
npm test        # needs the test database (above)
```
