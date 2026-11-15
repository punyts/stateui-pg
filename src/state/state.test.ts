import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { workspaceDb } from '../workspace/WorkspaceDb.js';
import { PgUiInstanceRepository } from '../workspace/PgUiInstanceRepository.js';
import { PgStateStore } from './PgStateStore.js';

const WORKSPACE = 'e0000000-0000-4000-8000-000000000005';
const APP = 'f0000000-0000-4000-8000-000000000006';
const ADDRESS = `${WORKSPACE}/${APP}/user`;

let test: TestDatabase;
const store = new PgStateStore();
const place = { workspaceId: WORKSPACE, address: ADDRESS };
const inWorkspace = <T>(work: Parameters<TestDatabase['db']['transaction']>[0]): Promise<T> => test.db.transaction(work, { workspaceIds: [WORKSPACE] }) as Promise<T>;
const changes = async (): Promise<Array<{ revision: number; path: string; op: string }>> =>
    (await test.db.query<{ revision: string; path: string; op: string }>('SELECT revision, path, op FROM state_change WHERE address = $1 ORDER BY revision, seq', [ADDRESS])).rows.map((row) => ({ ...row, revision: Number(row.revision) }));

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
});

afterAll(async () => {
    await test.drop();
});

describe('PgStateStore', () => {
    it('should read a namespace back in the key order it was written in, a row per top-level key and per record', async () => {
        // Arrange
        const state = { theme: { active: { mode: 'dark' } }, route: { screen: 'b' }, data: { mine: { z: { n: 1 }, a: { n: 2 }, m: { n: 3 } } } };

        // Act
        await inWorkspace((tx) => store.write(tx, place, '', state));
        const read = await inWorkspace<Awaited<ReturnType<PgStateStore['read']>>>((tx) => store.read(tx, ADDRESS));
        const rows = (await test.db.query<{ path: string }>('SELECT path FROM state_node WHERE address = $1 ORDER BY path', [ADDRESS])).rows.map((row) => row.path);

        // Assert
        expect(JSON.stringify(read.value)).toBe(JSON.stringify(state));
        expect(rows).toEqual(['data', 'data.mine', 'data.mine.a', 'data.mine.m', 'data.mine.z', 'route', 'theme']);
        expect(read.revision).toBe(1);
    });

    it('should rewrite and log only the row a change touches, and take no revision for a write that changes nothing', async () => {
        // Arrange
        const before = await changes();

        // Act
        await inWorkspace((tx) => store.write(tx, place, 'data.mine', { z: { n: 1 }, a: { n: 20 }, m: { n: 3 } }));
        const same = await inWorkspace<number>((tx) => store.write(tx, place, 'data.mine', { z: { n: 1 }, a: { n: 20 }, m: { n: 3 } }));

        // Assert
        expect((await changes()).slice(before.length)).toEqual([{ revision: 2, path: 'data.mine.a', op: 'set' }]);
        expect(same).toBe(2);
    });

    it('should replace the top-level keys of a whole write and leave the ones it keeps', async () => {
        // Act
        await inWorkspace((tx) => store.write(tx, place, '', { route: { screen: 'c' } }, { keep: ['data'] }));
        const read = await inWorkspace<Awaited<ReturnType<PgStateStore['read']>>>((tx) => store.read(tx, ADDRESS));

        // Assert
        expect(read.value).toEqual({ route: { screen: 'c' }, data: { mine: { z: { n: 1 }, a: { n: 20 }, m: { n: 3 } } } });
    });

    it('should show a namespace to the transactions of its workspace only, for a role without BYPASSRLS', async () => {
        // Arrange
        await test.db.query('DO $$ BEGIN CREATE ROLE punyts_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
        await test.db.query(`GRANT USAGE ON SCHEMA ${test.schema} TO punyts_rls_test`);
        await test.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${test.schema} TO punyts_rls_test`);
        const readAs = (workspaceId: string) =>
            test.db.transaction(
                async (tx) => {
                    await tx.query('SET LOCAL ROLE punyts_rls_test');
                    return store.read(tx, ADDRESS);
                },
                { workspaceIds: [workspaceId] }
            );

        // Act
        const other = await readAs('a0000000-0000-4000-8000-000000000009');
        const own = await readAs(WORKSPACE);

        // Assert
        expect(other.value).toBeUndefined();
        expect(own.value).toBeDefined();
    });
});

describe('PgUiInstanceRepository on state_node', () => {
    it("should keep a persona's diff, its own unbound data and its persona records apart, each at the persona's address", async () => {
        // Arrange
        const repository = new PgUiInstanceRepository(workspaceDb(test.db, WORKSPACE), 'u1');
        const app = '10000000-0000-4000-8000-000000000007';

        // Act
        await repository.writeData(app, 'notes', { model: 'note', records: { b: { text: 'two' }, a: { text: 'one' } } } as never);
        await repository.write(app, { app: {}, screens: {}, data: {} } as never, { app: {}, screens: { home: { x: 1 } }, data: { draft: 'hi' } } as never);

        // Assert
        expect((await repository.get(app)).value).toEqual({ screens: { home: { x: 1 } }, data: { draft: 'hi' } });
        expect(JSON.stringify((await repository.getData(app, 'notes')).value)).toBe(JSON.stringify({ model: 'note', records: { b: { text: 'two' }, a: { text: 'one' } } }));
        const addresses = (await test.db.query<{ address: string }>('SELECT DISTINCT address FROM state_node WHERE address LIKE $1', [`%/${app}/user`])).rows.map((row) => row.address);
        expect(addresses).toEqual([`u1/${app}/user`]);
    });
});

describe('0004_state', () => {
    it('should move the instances and persona records of 0001 to their addresses, in key order, and drop their tables', async () => {
        // Arrange: a schema at 0003, with an instance and persona records in the old tables
        const dir = await mkdtemp(join(tmpdir(), 'stateui-pg-'));
        const older = await createTestDatabase();
        try {
            for (const file of (await readdir(STATEUI_PG_MIGRATIONS.dir)).filter((name) => name < '0004')) await copyFile(join(STATEUI_PG_MIGRATIONS.dir, file), join(dir, file));
            await migrate(older.db, [{ owner: 'stateui-pg', dir }]);
            await older.db.query("INSERT INTO instance (workspace_id, persona, app_id, diff, updated_at) VALUES ($1, 'default', $2, $3, '2026-01-02T00:00:00Z')", [WORKSPACE, APP, '{"route":{"screen":"b"},"theme":{"x":1}}']);
            await older.db.query("INSERT INTO persona_dataset (workspace_id, persona, app_id, binding, model, records) VALUES ($1, 'u2', $2, 'bag', 'line', $3)", [WORKSPACE, APP, '{"k2":{"q":2},"k1":{"q":1}}']);

            // Act
            await migrate(older.db, [STATEUI_PG_MIGRATIONS]);

            // Assert
            const mine = await older.db.transaction((tx) => store.read(tx, ADDRESS), { workspaceIds: [WORKSPACE] });
            const theirs = await older.db.transaction((tx) => store.read(tx, `u2/${APP}/user`), { workspaceIds: [WORKSPACE] });
            expect(JSON.stringify(mine.value)).toBe('{"route":{"screen":"b"},"theme":{"x":1}}');
            expect(JSON.stringify(theirs.value)).toBe('{"data":{"bag":{"k2":{"q":2},"k1":{"q":1}}}}');
            expect(theirs.meta.get('data.bag')).toEqual({ model: 'line' });
            const head = (await older.db.query<{ updated_at: Date }>('SELECT updated_at FROM namespace_head WHERE address = $1', [ADDRESS])).rows[0];
            expect(head?.updated_at.toISOString()).toBe('2026-01-02T00:00:00.000Z');
            expect((await older.db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('instance', 'persona_dataset')")).rowCount).toBe(0);
        } finally {
            await older.drop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
