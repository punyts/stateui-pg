import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FencedError } from '@punyts/state-sync/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { workspaceDb } from '../workspace/WorkspaceDb.js';
import { pgWorkspaceStorage } from '../workspace/PgWorkspaceStorage.js';
import { PgStateStore } from './PgStateStore.js';

const WORKSPACE = 'e0000000-0000-4000-8000-000000000005';
const APP = 'f0000000-0000-4000-8000-000000000006';
const ADDRESS = `${WORKSPACE}/apps/${APP}`;

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

describe('instances as stored namespaces on state_node', () => {
    it("should keep a persona's diff, its own unbound data and its persona records apart, each at the persona's address", async () => {
        // Arrange
        const repository = pgWorkspaceStorage(test.db, WORKSPACE).instances('u1');
        const app = '10000000-0000-4000-8000-000000000007';

        // Act
        await repository.writeData(app, 'notes', { model: 'note', records: { b: { text: 'two' }, a: { text: 'one' } } } as never);
        await repository.write(app, { app: {}, screens: {}, data: {} } as never, { app: {}, screens: { home: { x: 1 } }, data: { draft: 'hi' } } as never);

        // Assert
        expect((await repository.get(app)).value).toEqual({ screens: { home: { x: 1 } }, data: { draft: 'hi' } });
        expect(JSON.stringify((await repository.getData(app, 'notes')).value)).toBe(JSON.stringify({ model: 'note', records: { b: { text: 'two' }, a: { text: 'one' } } }));
        const addresses = (await test.db.query<{ address: string }>('SELECT DISTINCT address FROM state_node WHERE address LIKE $1', [`%/apps/${app}`])).rows.map((row) => row.address);
        expect(addresses).toEqual([`u1/apps/${app}`]);
    });

    it('should refuse a save under an older epoch than the instance was last saved under, and take a newer one', async () => {
        // Arrange
        const repository = pgWorkspaceStorage(test.db, WORKSPACE).instances('u2');
        const app = '10000000-0000-4000-8000-000000000008';
        const empty = { app: {}, screens: {}, data: {} } as never;
        await repository.write(app, empty, { app: {}, screens: { home: { x: 1 } }, data: {} } as never, { epoch: 2 });

        // Act
        const older = repository.write(app, empty, { app: {}, screens: { home: { x: 99 } }, data: {} } as never, { epoch: 1 });
        const olderData = repository.writeData(app, 'notes', { model: 'note', records: { a: { text: 'late' } } } as never, { epoch: 1 });
        await expect(older).rejects.toBeInstanceOf(FencedError);
        await expect(olderData).rejects.toBeInstanceOf(FencedError);
        await repository.write(app, empty, { app: {}, screens: { home: { x: 3 } }, data: {} } as never, { epoch: 3 });

        // Assert
        expect((await repository.get(app)).value).toEqual({ screens: { home: { x: 3 } } });
        const head = (await test.db.query<{ epoch: string }>('SELECT epoch FROM namespace_head WHERE address = $1', [`u2/apps/${app}`])).rows[0];
        expect(Number(head?.epoch)).toBe(3);
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
            const theirs = await older.db.transaction((tx) => store.read(tx, `u2/apps/${APP}`), { workspaceIds: [WORKSPACE] });
            expect(JSON.stringify(mine.value)).toBe('{"route":{"screen":"b"},"theme":{"x":1}}');
            // 0006 then puts the binding's model into the namespace's own state, after its other keys
            expect(JSON.stringify(theirs.value)).toBe('{"data":{"bag":{"k2":{"q":2},"k1":{"q":1}}},"models":{"bag":"line"}}');
            expect(mine.value).not.toHaveProperty('models');
            // and the instance reads back whole from the rows of before: its records with their model, in key order
            const migrated = pgWorkspaceStorage(older.db, WORKSPACE).instances('u2');
            expect(JSON.stringify((await migrated.getData(APP, 'bag')).value)).toBe('{"model":"line","records":{"k2":{"q":2},"k1":{"q":1}}}');
            // a save after the migration leaves the binding's row without the model it used to keep
            await migrated.writeData(APP, 'bag', { model: 'line', records: { k2: { q: 2 }, k1: { q: 1 }, k3: { q: 3 } } } as never);
            const saved = await older.db.transaction((tx) => store.read(tx, `u2/apps/${APP}`), { workspaceIds: [WORKSPACE] });
            expect(JSON.stringify(saved.value)).toBe('{"data":{"bag":{"k2":{"q":2},"k1":{"q":1},"k3":{"q":3}}},"models":{"bag":"line"}}');
            expect(saved.meta.get('data.bag')).toBeUndefined();
            const head = (await older.db.query<{ updated_at: Date }>('SELECT updated_at FROM namespace_head WHERE address = $1', [ADDRESS])).rows[0];
            expect(head?.updated_at.toISOString()).toBe('2026-01-02T00:00:00.000Z');
            expect((await older.db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('instance', 'persona_dataset')")).rowCount).toBe(0);
        } finally {
            await older.drop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('0006_instance_models and 0007_owner_tree_addresses', () => {
    it("should run as the tables' owner, whom row-level security holds, and move every stored instance to `models` and its place in its owner's tree", async () => {
        // Arrange: an instance as it was stored before both, in a schema whose tables a plain role owns
        const older = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
        const owner = 'punyts_state_migration_owner';
        const app = '10000000-0000-4000-8000-000000000009';
        const was = `u9/${app}/user`;
        try {
            await older.db.transaction(
                async (tx) => {
                    await tx.query('INSERT INTO namespace_head (address, workspace_id, revision, epoch) VALUES ($1, $2, 4, 2)', [was, WORKSPACE]);
                    const row = 'INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision, epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, 4, 2)';
                    await tx.query(row, [WORKSPACE, was, 'route', '', 1, 'value', JSON.stringify({ screen: 'b' })]);
                    await tx.query(row, [WORKSPACE, was, 'data', '', 2, 'object', null]);
                    await tx.query(row, [WORKSPACE, was, 'data.bag', 'data', 1, 'object', JSON.stringify({ model: 'line' })]);
                    await tx.query(row, [WORKSPACE, was, 'data.bag.k1', 'data.bag', 1, 'value', JSON.stringify({ q: 1 })]);
                    await tx.query('DELETE FROM state_node WHERE address = $1 AND path = $2', [was, 'models']);
                    await tx.query("INSERT INTO embedding_job (workspace_id, source_kind, source_id, field) VALUES ($1, 'persona-record', $2, 'note'), ($1, 'record', 'd1/user/k', 'note')", [WORKSPACE, `${was}/bag/k1/x`]);
                    await tx.query('INSERT INTO namespace_owner (address, node, epoch, lease_until) VALUES ($1, $2, 2, now())', [was, 'n1']);
                },
                { workspaceIds: [WORKSPACE] }
            );
            await older.db.query(`DO $$ BEGIN CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
            await older.db.query(`GRANT USAGE ON SCHEMA ${older.schema} TO ${owner}`);
            for (const table of ['state_node', 'state_change', 'namespace_head', 'namespace_owner', 'embedding', 'embedding_job']) await older.db.query(`ALTER TABLE ${table} OWNER TO ${owner}`);
            const read = async (name: string): Promise<string> => (await import('node:fs/promises')).readFile(join(STATEUI_PG_MIGRATIONS.dir, name), 'utf8');

            // Act: both, twice over
            for (const name of ['0006_instance_models.sql', '0007_owner_tree_addresses.sql', '0006_instance_models.sql', '0007_owner_tree_addresses.sql']) {
                const sql = await read(name);
                await older.db.transaction(async (tx) => {
                    await tx.query(`SET LOCAL ROLE ${owner}`);
                    await tx.query(sql);
                });
            }

            // Assert
            const now = `u9/apps/${app}`;
            const state = await older.db.transaction((tx) => store.read(tx, now), { workspaceIds: [WORKSPACE] });
            expect(JSON.stringify(state.value)).toBe('{"route":{"screen":"b"},"data":{"bag":{"k1":{"q":1}}},"models":{"bag":"line"}}');
            expect((await older.db.transaction((tx) => store.read(tx, was), { workspaceIds: [WORKSPACE] })).value).toBeUndefined();
            expect(JSON.stringify((await pgWorkspaceStorage(older.db, WORKSPACE).instances('u9').getData(app, 'bag')).value)).toBe('{"model":"line","records":{"k1":{"q":1}}}');
            expect((await older.db.query<{ address: string }>('SELECT address FROM namespace_owner')).rows).toEqual([{ address: now }]);
            const jobs = (await older.db.transaction((tx) => tx.query<{ source_id: string }>('SELECT source_id FROM embedding_job ORDER BY source_id'), { workspaceIds: [WORKSPACE] })).rows.map((job) => job.source_id);
            expect(jobs).toEqual(['d1/user/k', `${now}/bag/k1/x`]);
            const forced = (await older.db.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relforcerowsecurity ORDER BY relname")).rows.map((row) => row.relname);
            expect(forced).toEqual(expect.arrayContaining(['embedding', 'namespace_head', 'state_change', 'state_node']));
        } finally {
            await older.db.query(`REASSIGN OWNED BY ${owner} TO CURRENT_USER`).catch(() => undefined);
            await older.drop();
        }
    });
});
