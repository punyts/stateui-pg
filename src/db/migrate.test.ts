import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { assertMigrated, migrate, pendingMigrations } from './migrate.js';

let test: TestDatabase;
let dir: string;

beforeEach(async () => {
    test = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
});

afterEach(async () => {
    await test.drop();
});

describe('migrate', () => {
    it('should apply pending files in version order, once', async () => {
        await writeFile(join(dir, '0002_more.sql'), 'ALTER TABLE thing ADD COLUMN more text;');
        await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id integer PRIMARY KEY);');
        await writeFile(join(dir, 'notes.txt'), 'not a migration');
        const sets = [{ owner: 'test', dir }];

        const first = await migrate(test.db, sets);
        const second = await migrate(test.db, sets);

        expect(first.map((migration) => migration.version)).toEqual([1, 2]);
        expect(second).toEqual([]);
        await test.db.query("INSERT INTO thing (id, more) VALUES (1, 'x')");
    });

    it('should roll a failed file back and keep the ones before it', async () => {
        await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id integer PRIMARY KEY);');
        await writeFile(join(dir, '0002_broken.sql'), 'CREATE TABLE other (id integer); SELECT nonsense FROM nowhere;');
        const sets = [{ owner: 'test', dir }];

        await expect(migrate(test.db, sets)).rejects.toThrow(/test 2 \(broken\) failed/);

        expect((await pendingMigrations(test.db, sets)).map((migration) => migration.version)).toEqual([2]);
        expect((await test.db.query("SELECT to_regclass('other') IS NULL AS gone")).rows[0]).toEqual({ gone: true });
    });

    it('should refuse a database that is behind', async () => {
        await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id integer PRIMARY KEY);');
        const sets = [{ owner: 'test', dir }];

        await expect(assertMigrated(test.db, sets)).rejects.toThrow(/behind/);
        await migrate(test.db, sets);
        await expect(assertMigrated(test.db, sets)).resolves.toBeUndefined();
    });
});
