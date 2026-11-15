import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDatabase } from '../db/Database.js';
import type { Database } from '../db/Database.js';
import { migrate } from '../db/migrate.js';
import type { MigrationSet } from '../db/migrate.js';

/** The environment variable that names the database the tests run against */
export const TEST_DATABASE_ENV = 'PUNYTS_TEST_DATABASE_URL';

/** A schema of its own in the test database, dropped by `drop` */
export interface TestDatabase {
    readonly db: Database;
    /** The schema's name */
    readonly schema: string;
    /** The URL of the test database, for a server under test to open its own pool on */
    readonly url: string;
    /** The pool settings that put a connection in this schema */
    readonly config: { readonly options: string };
    /** Ends the pool and drops the schema with everything in it */
    drop(): Promise<void>;
}

/** The database `npm run magnetic:db` starts in Docker, which the tests use when nothing else is set */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://magnetic:magnetic@127.0.0.1:5433/magnetic';

/** The test database's URL: `PUNYTS_TEST_DATABASE_URL`, or the development database */
export function testDatabaseUrl(): string {
    const url = process.env[TEST_DATABASE_ENV];
    return url === undefined || url === '' ? DEFAULT_TEST_DATABASE_URL : url;
}

/**
 * A fresh schema in the test database, so test files run side by side without seeing each other's rows, with the
 * given migrations applied. The `vector` extension is made once in `public`, which stays on the search path
 */
export async function createTestDatabase(sets: readonly MigrationSet[] = []): Promise<TestDatabase> {
    const url = testDatabaseUrl();
    const admin = new pg.Client({ connectionString: url });
    try {
        await admin.connect();
    } catch (error) {
        throw new Error(`The tests need Postgres with pgvector at ${url}: start it with npm run magnetic:db, or set ${TEST_DATABASE_ENV}`, { cause: error });
    }
    const schema = `test_${randomBytes(6).toString('hex')}`;
    try {
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => undefined);
        await admin.query('CREATE EXTENSION IF NOT EXISTS ltree').catch(() => undefined);
        await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
        await admin.end();
    }
    const config = { options: `-c search_path=${schema},public` };
    const db = createDatabase({ url, config: { ...config, max: 5 } });
    await migrate(db, sets);
    return {
        db,
        schema,
        url,
        config,
        drop: async () => {
            await db.close();
            const cleanup = new pg.Client({ connectionString: url });
            await cleanup.connect();
            try {
                await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
            } finally {
                await cleanup.end();
            }
        }
    };
}
