# @punyts/stateui-pg

Postgres storage for StateUI servers. It holds the pieces every database-backed server needs, and Magnetic uses it:

- `createDatabase({ url })`: one `pg` pool, `query`, and `transaction(work, { workspaceIds })`, which sets
  `app.workspace_ids` for the transaction so row-level security shows only those workspaces' rows.
- `migrate(db, sets)`, `pendingMigrations` and `assertMigrated`: numbered SQL files (`0001_name.sql`), one folder per
  owner, each applied in its own transaction and recorded in `schema_migration`. An advisory lock keeps two servers from
  migrating at once. Plain Node, so it runs from cmd, PowerShell and bash.
- `STATEUI_PG_MIGRATIONS`: this library's own tables (`migrations/`).
- `grantAppRole(db, role, { readOnlyState })` and `grantAggregateRole(db, role, reads)`: the rights of the role the
  servers connect as and of the aggregate's. The aggregate's role writes the state tables and, in `statenet_node`,
  only the rows of relays (restrictive row-level security policies), which it lists while they are linked to it.
- `PgDirectory`: the statenet's nodes (`register`, `heartbeat`, `remove`, `sweep`, `nodes`), and `PgOwnershipStore`
  and `PgEpochStorage` for who owns a namespace and its stored state: its rows, its log, and on its head the revision,
  serial, applied ids and requests. The pending requests are listed without values in `pending_request` (address, id,
  owner, subject, at, until), a state table, so a server lists what waits for a person without loading namespaces
  (`docs/design/statenet-requests.md`).
- `pgWorkspaceStorage(db, workspaceId, options)`: one workspace's `ServicesStorage` for `createServices`. A dataset's
  records live in its namespace `<owner>/data/<dataset>` (rows at `data.records.<key>`), saved through `datasets`; the
  part keeps the model. `importPart` splits an imported dataset that way, and `txSeedDataset` does it inside a
  transaction an import already holds. With `embedRecords`, a save of a dataset's namespace queues the record fields its
  model embeds (source ids `<owner>/data/<dataset>/<key>`), and a model change queues every record of its datasets.
  An owner's test run (`<owner>/apps/<appId>.test`, docs/design/stateui-test-runs.md) is stored as a person's state,
  through `instances(testPersonOf(owner))`; its copies of datasets are never embedded, and `removeApp` removes it with
  every person's instance of the app.
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
