import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datasetStateAddress, installShowcaseInto, MAX_FILES_PER_APP } from '@punyts/stateui-mcp';
import type { ServicesStorage } from '@punyts/stateui-mcp';
import { createDatabase } from '../db/Database.js';
import type { Database } from '../db/Database.js';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { pgWorkspaceStorage } from './PgWorkspaceStorage.js';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const silent = { info: () => undefined } as never;

let test: TestDatabase;
let alice: ServicesStorage;
let bob: ServicesStorage;

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
    alice = pgWorkspaceStorage(test.db, ALICE);
    bob = pgWorkspaceStorage(test.db, BOB);
});

afterAll(async () => {
    await test.drop();
});

async function appOf(storage: ServicesStorage, name: string): Promise<string> {
    const created = await storage.parts.create({
        kind: 'apps',
        name,
        body: {
            home: 'home',
            screens: { home: { root: { component: 'column' } } }
        } as never
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    return created.part.id;
}

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(text);
}

describe('instances', () => {
    it("should keep each person's diff over the definition, in key order, and drop it when it is empty", async () => {
        // Arrange
        const app = await appOf(alice, 'counter');
        const own = alice.instances(ALICE);
        const bobsUse = alice.instances(BOB);
        const definition = { data: { count: 0, label: 'x' } };

        // Act
        const written = await own.write(app, definition, {
            data: { zeta: 1, count: 2, alpha: 3, label: 'x' }
        });
        const read = await own.get(app);
        const other = await bobsUse.get(app);
        await own.write(app, definition, definition);
        const emptied = await own.get(app);

        // Assert
        expect(written).toEqual({ data: { zeta: 1, count: 2, alpha: 3 } });
        expect(Object.keys((read.value['data'] ?? {}) as object)).toEqual(['zeta', 'count', 'alpha']);
        expect(other.value).toEqual({});
        expect(emptied.value).toEqual({});
    });

    it('should keep person records per binding and remove them with the instance on reset', async () => {
        // Arrange
        const app = await appOf(alice, 'notes');
        const own = alice.instances(ALICE);
        await own.write(app, { route: { screen: 'home' } }, { route: { screen: 'edit' } });

        // Act
        await own.writeData(app, 'notes', {
            model: 'note',
            records: { b: { text: 'two' }, a: { text: 'one' } }
        });
        const before = await own.getData(app, 'notes');
        await own.reset(app);

        // Assert
        expect(Object.keys(before.value?.records ?? {})).toEqual(['b', 'a']);
        expect((await own.getData(app, 'notes')).value).toBeUndefined();
        expect((await own.get(app)).value).toEqual({});
    });

    it("should remove every person's instance of an app with removeApp, and keep the other apps'", async () => {
        // Arrange
        const app = await appOf(alice, 'shared');
        const other = await appOf(alice, 'kept');
        const definition = { route: { screen: 'home' } };
        const changed = { route: { screen: 'edit' } };
        await alice.instances(ALICE).write(app, definition, changed);
        await alice.instances(BOB).write(app, definition, changed);
        await alice.instances(BOB).write(other, definition, changed);

        // Act
        await alice.removeApp?.(app);

        // Assert
        expect((await alice.instances(ALICE).get(app)).value).toEqual({});
        expect((await alice.instances(BOB).get(app)).value).toEqual({});
        expect((await alice.instances(BOB).get(other)).value).toEqual(changed);
    });
});

describe('Files', () => {
    it('should store bytes and metadata, list the newest first, and refuse an app that does not exist', async () => {
        // Arrange
        const app = await appOf(alice, 'gallery');
        const first = 'f0000000-0000-4000-8000-000000000001';
        const second = 'f0000000-0000-4000-8000-000000000002';

        // Act
        const saved = await alice.fileStore.save(app, first, bytesOf('hello'), 100);
        const tooLarge = await alice.fileStore.save(app, second, bytesOf('x'.repeat(200)), 100);
        const added =
            saved.kind === 'saved'
                ? await alice.files.add({
                      id: first,
                      appId: app,
                      name: 'hello.txt',
                      size: saved.size,
                      type: 'text/plain',
                      sha256: saved.sha256
                  })
                : undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await alice.files.add({
            id: second,
            appId: app,
            name: 'two.txt',
            size: 1,
            type: 'text/plain',
            sha256: 'x'
        });
        const missing = await alice.files.add({
            id: second,
            appId: 'c0000000-0000-4000-8000-000000000009',
            name: 'x',
            size: 1,
            type: 'text/plain',
            sha256: 'x'
        });

        // Assert
        expect(saved).toMatchObject({
            kind: 'saved',
            size: 5,
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
        });
        expect(tooLarge).toEqual({ kind: 'too-large' });
        expect(added).toMatchObject({
            kind: 'added',
            file: { id: first, appId: app, name: 'hello.txt', size: 5 }
        });
        expect((await alice.files.list(app)).map((file) => file.name)).toEqual(['two.txt', 'hello.txt']);
        expect(new TextDecoder().decode(await alice.fileStore.read(app, first))).toBe('hello');
        expect(missing).toEqual({ kind: 'not-found' });
        expect(await alice.files.usage(app)).toEqual({ count: 2, bytes: 6 });
    });

    it('should open a range of a file, cut in the database, and the whole file without one', async () => {
        // Arrange
        const app = await appOf(alice, 'ranges');
        const id = 'f0000000-0000-4000-8000-000000000011';
        await alice.fileStore.save(app, id, bytesOf('0123456789'), 100);
        const text = async (stream: AsyncIterable<Uint8Array> | undefined): Promise<string | undefined> => {
            if (stream === undefined) return undefined;
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        };

        // Act
        const middle = await text(await alice.fileStore.open(app, id, { start: 2, end: 5 }));
        const last = await text(await alice.fileStore.open(app, id, { start: 9, end: 9 }));
        const whole = await text(await alice.fileStore.open(app, id));
        const missing = await alice.fileStore.open(app, 'f0000000-0000-4000-8000-000000000012', { start: 0, end: 1 });

        // Assert
        expect([middle, last, whole, missing]).toEqual(['2345', '9', '0123456789', undefined]);
    });

    it('should never pass the file quota when two servers add files to one app at once', async () => {
        // Arrange
        const app = await appOf(alice, 'crowded');
        const second: Database = createDatabase({
            url: test.url,
            config: { ...test.config, max: 5 }
        });
        const elsewhere = pgWorkspaceStorage(second, ALICE);
        const idOf = (n: number): string => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

        // Act
        const results = await Promise.all(
            Array.from({ length: MAX_FILES_PER_APP + 10 }, (_, n) =>
                (n % 2 === 0 ? alice : elsewhere).files.add({
                    id: idOf(n),
                    appId: app,
                    name: `${n}.txt`,
                    size: 1,
                    type: 'text/plain',
                    sha256: 'x'
                })
            )
        );
        await second.close();

        // Assert
        expect(results.filter((result) => result.kind === 'added')).toHaveLength(MAX_FILES_PER_APP);
        expect(results.filter((result) => result.kind === 'quota')).toHaveLength(10);
        expect((await alice.files.usage(app)).count).toBe(MAX_FILES_PER_APP);
    });

    it('should delete a file unless something references it, and remove what goes with a deleted app', async () => {
        // Arrange
        const app = await appOf(alice, 'shelf');
        const file = 'd0000000-0000-4000-8000-000000000001';
        await alice.fileStore.save(app, file, bytesOf('bytes'), 100);
        await alice.files.add({
            id: file,
            appId: app,
            name: 'a.txt',
            size: 5,
            type: 'text/plain',
            sha256: 'x'
        });
        await alice.errorLog.append(app, {
            code: 'X',
            message: 'broken',
            severity: 'error'
        } as never);

        // Act
        const kept = await alice.files.deleteUnlessReferenced(app, file, async () => true);
        await alice.appFolders.remove(app);

        // Assert
        expect(kept).toBe('referenced');
        expect(await alice.files.list(app)).toEqual([]);
        expect(await alice.fileStore.open(app, file)).toBeUndefined();
        expect(await alice.errorLog.list(app)).toEqual([]);
    });
});

describe('PgUiErrorLog', () => {
    it('should keep the newest errors of a stored app, and only the latest load of a view when asked', async () => {
        // Arrange
        const app = await appOf(alice, 'flaky');
        const error = (n: number): never => ({ code: `E${n}`, message: `error ${n}`, severity: 'error' }) as never;

        // Act
        const stored = await alice.errorLog.append(app, error(1), {
            viewId: 'v1',
            load: 1
        });
        await alice.errorLog.append(app, error(2), { viewId: 'v1', load: 2 });
        await alice.errorLog.append(app, error(3), { viewId: 'v2', load: 1 });
        const notAnApp = await alice.errorLog.append('c0000000-0000-4000-8000-000000000009', error(4));
        await alice.errorLog.keepFrom(app, { viewId: 'v1', load: 2 });

        // Assert
        expect(stored).toBe(true);
        expect(notAnApp).toBe(false);
        expect((await alice.errorLog.list(app)).map((logged) => logged.code)).toEqual(['E2']);
    });
});

describe('Isolation', () => {
    it("should never show one workspace another's parts, instances or files", async () => {
        // Arrange
        const app = await appOf(alice, 'private');
        await alice.instances(ALICE).write(app, {}, { data: { secret: 1 } });
        await alice.fileStore.save(app, 'c0000000-0000-4000-8000-000000000001', bytesOf('secret'), 100);

        // Act
        const seen = {
            byId: await bob.parts.findById('apps', app),
            byName: await bob.parts.findByName('apps', 'private'),
            list: (await bob.parts.list('apps')).map((part) => part.name),
            instance: (await bob.instances(BOB).get(app)).value,
            exists: await bob.files.appExists(app),
            bytes: await bob.fileStore.open(app, 'c0000000-0000-4000-8000-000000000001')
        };
        const sameName = await bob.parts.create({
            kind: 'apps',
            name: 'private',
            body: { home: 'home', screens: {} } as never
        });

        // Assert
        expect(seen).toEqual({
            byId: undefined,
            byName: undefined,
            list: [],
            instance: {},
            exists: false,
            bytes: undefined
        });
        expect(sameName.kind).toBe('created');
    });

    it('should return no rows to a role without BYPASSRLS that has not set its workspace, or set another', async () => {
        // Arrange
        await appOf(alice, 'guarded');
        await test.db.query('DO $$ BEGIN CREATE ROLE punyts_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
        await test.db.query(`GRANT USAGE ON SCHEMA ${test.schema} TO punyts_rls_test`);
        await test.db.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${test.schema} TO punyts_rls_test`);

        // Act
        const count = (workspaceIds?: readonly string[]): Promise<number> =>
            test.db.transaction(
                async (tx) => {
                    await tx.query('SET LOCAL ROLE punyts_rls_test');
                    return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM part')).rows[0]?.n ?? -1;
                },
                workspaceIds === undefined ? {} : { workspaceIds }
            );
        const none = await count();
        const others = await count([BOB]);
        const own = await count([ALICE]);
        const insertElsewhere = (): Promise<void> =>
            test.db.transaction(
                async (tx) => {
                    await tx.query('SET LOCAL ROLE punyts_rls_test');
                    await tx.query("INSERT INTO part (workspace_id, kind, id, name, revision, body, created_at, updated_at) VALUES ($1, 'apps', gen_random_uuid(), 'sneaky', 1, '{}', now(), now())", [
                        ALICE
                    ]);
                },
                { workspaceIds: [BOB] }
            );

        // Assert
        expect(none).toBe(0);
        expect(own).toBeGreaterThan(0);
        expect(others).toBe((await bob.parts.list('apps')).length);
        await expect(insertElsewhere()).rejects.toThrow(/row-level security/);
    });
});

describe('installShowcaseInto', () => {
    it('should install the showcase with its files into an empty workspace, once', async () => {
        // Arrange
        const fresh = pgWorkspaceStorage(test.db, 'c0000000-0000-4000-8000-0000000000aa');

        // Act
        const first = await installShowcaseInto({
            parts: fresh.parts,
            files: fresh.files,
            fileStore: fresh.fileStore,
            importPart: fresh.importPart,
            report: silent
        });
        const second = await installShowcaseInto({
            parts: fresh.parts,
            files: fresh.files,
            fileStore: fresh.fileStore,
            importPart: fresh.importPart,
            report: silent
        });

        // Assert
        expect(first).toBe(true);
        expect(second).toBe(false);
        const apps = await fresh.parts.list('apps');
        expect(apps.map((app) => app.name)).toContain('component-showcase');
        const showcase = apps.find((app) => app.name === 'component-showcase');
        expect((await fresh.files.list(showcase?.id ?? '')).length).toBeGreaterThan(0);
    });
});

describe('importPart', () => {
    it("should keep an imported dataset's records in its namespace, and import it only once", async () => {
        // Arrange
        const fresh = pgWorkspaceStorage(test.db, 'c0000000-0000-4000-8000-0000000000ab');
        const part = { kind: 'data' as const, id: 'e0000000-0000-4000-8000-0000000000ab', name: 'catalog', revision: 1, createdAt: new Date(), updatedAt: new Date(), body: { model: 'product', records: { p1: { name: 'Lamp' } } } as never };

        // Act
        await fresh.importPart?.(part);
        await fresh.importPart?.({ ...part, body: { model: 'product', records: { p2: { name: 'Chair' } } } as never });

        // Assert
        expect((await fresh.parts.findByName('data', 'catalog'))?.body).toEqual({ model: 'product' });
        expect(await fresh.datasets.load(datasetStateAddress('c0000000-0000-4000-8000-0000000000ab', 'catalog'))).toMatchObject({
            revision: 1,
            state: { data: { records: { p1: { name: 'Lamp' } } } }
        });
    });
});
