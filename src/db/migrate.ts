import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './Database.js';

/** A folder of numbered SQL files with one owner: `0001_people.sql`, `0002_orgs.sql`, ... */
export interface MigrationSet {
    /** Names the set in `schema_migration`, such as `stateui-pg` or `magnetic` */
    readonly owner: string;
    readonly dir: string;
}

export interface Migration {
    readonly owner: string;
    readonly version: number;
    readonly name: string;
    readonly path: string;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** The advisory lock every migrator takes, so two servers starting at once never migrate together */
const LOCK = 7_340_271_022;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migration (
    owner text NOT NULL,
    version integer NOT NULL,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, version)
)`;

/** The migrations of a set, in version order. Two files with one version are an error */
export async function readMigrations(set: MigrationSet): Promise<Migration[]> {
    const found: Migration[] = [];
    for (const file of (await readdir(set.dir)).sort()) {
        const match = FILE.exec(file);
        if (match === null) continue;
        const version = Number(match[1]);
        if (found.some((migration) => migration.version === version)) throw new Error(`Two migrations of ${set.owner} have version ${version}`);
        found.push({ owner: set.owner, version, name: match[2] ?? '', path: join(set.dir, file) });
    }
    return found;
}

/** The migrations of the sets that the database has not applied yet, in the order they would run */
export async function pendingMigrations(db: Database, sets: readonly MigrationSet[]): Promise<Migration[]> {
    const exists = await db.query<{ found: boolean }>("SELECT to_regclass('schema_migration') IS NOT NULL AS found");
    const applied = new Set<string>();
    if (exists.rows[0]?.found === true) {
        for (const row of (await db.query<{ owner: string; version: number }>('SELECT owner, version FROM schema_migration')).rows) applied.add(`${row.owner}:${row.version}`);
    }
    const pending: Migration[] = [];
    for (const set of sets) for (const migration of await readMigrations(set)) if (!applied.has(`${migration.owner}:${migration.version}`)) pending.push(migration);
    return pending;
}

/**
 * Applies the pending migrations of each set, set by set in the order given and file by file in version order, each in
 * its own transaction with its `schema_migration` row. Returns what it applied
 */
export async function migrate(db: Database, sets: readonly MigrationSet[]): Promise<Migration[]> {
    const client = await db.pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
        await client.query(CREATE_TABLE);
        const applied: Migration[] = [];
        for (const migration of await pendingMigrations(db, sets)) {
            const sql = await readFile(migration.path, 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migration (owner, version, name) VALUES ($1, $2, $3)', [migration.owner, migration.version, migration.name]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw new Error(`Migration ${migration.owner} ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            applied.push(migration);
        }
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
        client.release();
    }
}

/** Refuses a database that is behind the given sets: a server never runs on a schema older than its code */
export async function assertMigrated(db: Database, sets: readonly MigrationSet[]): Promise<void> {
    const pending = await pendingMigrations(db, sets);
    if (pending.length > 0) {
        throw new Error(`The database is behind: ${pending.length} migration(s) to apply (${pending.map((migration) => `${migration.owner} ${migration.version}`).join(', ')}). Run \`magnetic migrate\` first`);
    }
}
