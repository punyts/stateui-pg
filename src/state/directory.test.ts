import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FencedError, OwnerNode } from '@punyts/state-sync/authority';
import type { Change } from '@punyts/state-sync';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { PgDirectory, PgEpochStorage, PgOwnershipStore } from './PgDirectory.js';

const WORKSPACE = 'b0000000-0000-4000-8000-0000000000aa';
let test: TestDatabase;
let counter = 0;
const change = (path: string, value: unknown): Change => ({ id: `c${++counter}`, path, op: 'set', value: value as never, base: 0 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
});

afterAll(async () => {
    await test.drop();
});

describe('PgOwnershipStore', () => {
    it('should give a namespace one owner at a time: taken, refused while its lease runs, handed off by epoch, taken over once it lapses', async () => {
        // Arrange
        const store = new PgOwnershipStore(test.db);
        const address = 'u1/a1/user';

        // Act
        const first = await store.take(address, 'a', 60_000);
        const refused = await store.take(address, 'b', 60_000);
        const staleRenew = await store.renew(address, 'a', 7, 60_000);
        const handedOff = await store.take(address, 'b', 30, first?.epoch);
        await pause(80);
        const takenOver = await store.take(address, 'c', 60_000);

        // Assert
        expect(first).toMatchObject({ node: 'a', epoch: 1 });
        expect(refused).toBeUndefined();
        expect(staleRenew).toBe(false);
        expect(handedOff).toMatchObject({ node: 'b', epoch: 2 });
        expect(takenOver).toMatchObject({ node: 'c', epoch: 3 });
    });
});

describe('PgDirectory', () => {
    it('should list the nodes that heartbeat, and take out the ones that stopped', async () => {
        // Arrange
        const directory = new PgDirectory(test.db);
        await directory.register({ id: 'node-a', role: 'owner', region: 'eu' });
        await directory.register({ id: 'node-b', role: 'relay', parent: 'node-a' });
        await test.db.query("UPDATE statenet_node SET heartbeat_at = now() - interval '1 minute' WHERE id = 'node-b'");

        // Act
        const beat = await directory.heartbeat('node-a');
        const swept = await directory.sweep(10_000);

        // Assert
        expect(beat).toBe(true);
        expect(swept).toEqual(['node-b']);
        expect((await directory.nodes()).map((node) => node.id)).toEqual(['node-a']);
        expect(await directory.heartbeat('node-b')).toBe(false);
    });
});

describe('PgEpochStorage', () => {
    it('should keep a namespace with its log and applied ids, and refuse a save from an older epoch', async () => {
        // Arrange
        const storage = new PgEpochStorage(test.db, () => WORKSPACE);
        const address = `${WORKSPACE}/e1/app`;
        const stored = { state: { data: { b: 2, a: 1 } }, revision: 2, log: [{ id: 'x', path: '$.data.a', op: 'set' as const, value: 1, base: 0, revision: 1 }, { id: 'y', path: '$.data.b', op: 'set' as const, value: 2, base: 1, revision: 2 }], applied: [{ id: 'x', revision: 1 }, { id: 'y', revision: 2 }] };

        // Act
        await storage.save(address, stored, 2);
        const loaded = await storage.load(address);
        const late = storage.save(address, { ...stored, state: { data: { late: true } } }, 1);

        // Assert
        expect(JSON.stringify(loaded?.state)).toBe('{"data":{"b":2,"a":1}}');
        expect(loaded?.log.map((logged) => logged.id)).toEqual(['x', 'y']);
        expect(loaded?.applied).toEqual(stored.applied);
        await expect(late).rejects.toBeInstanceOf(FencedError);
        expect((await storage.load(address))?.state).toEqual({ data: { b: 2, a: 1 } });
    });
});

describe('two owner nodes on one database', () => {
    it('should hand a namespace from one app server to another with every write applied once, and fence the old one', async () => {
        // Arrange
        const ownership = new PgOwnershipStore(test.db);
        const storage = new PgEpochStorage(test.db, () => WORKSPACE);
        const address = `${WORKSPACE}/n1/app`;
        const nodes = new Map<string, OwnerNode>();
        const make = (id: string) => {
            const node = new OwnerNode({ id, ownership, storage, link: (other) => nodes.get(other), initial: () => ({ data: {} }), leaseMs: 60_000 });
            nodes.set(id, node);
            return node;
        };
        const a = make('server-a');
        const b = make('server-b');
        await a.write(address, change('$.data.start', 0));

        // Act
        const writes = [];
        for (let index = 0; index < 20; index++) {
            writes.push((index % 2 === 0 ? a : b).write(address, change(`$.data.k${index}`, index)));
            if (index === 8) writes.push(b.claim(address).then(() => undefined));
        }
        const outcomes = (await Promise.all(writes)).filter((outcome) => outcome !== undefined);
        await b.authorityOf(address)?.flush();
        const stored = await storage.load(address);

        // Assert
        expect(outcomes.filter((outcome) => outcome.result !== 'applied')).toEqual([]);
        expect(outcomes.map((outcome) => (outcome as { revision: number }).revision).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
        expect(b.owned()).toEqual([address]);
        expect(Object.keys((stored?.state as { data: object }).data)).toHaveLength(21);
        expect((await ownership.get(address))?.epoch).toBe(2);
        await expect(storage.save(address, stored as never, 1)).rejects.toBeInstanceOf(FencedError);
    });

    it('should let two servers that both get the first write of a namespace agree on one owner, and apply both', async () => {
        // Arrange
        const ownership = new PgOwnershipStore(test.db);
        const storage = new PgEpochStorage(test.db, () => WORKSPACE);
        const address = `${WORKSPACE}/race/app`;
        const nodes = new Map<string, OwnerNode>();
        for (const id of ['first', 'second']) nodes.set(id, new OwnerNode({ id, ownership, storage, link: (other) => nodes.get(other), initial: () => ({ data: {} }), leaseMs: 60_000 }));

        // Act
        const outcomes = await Promise.all([...nodes.values()].map((node, index) => node.write(address, change(`$.data.from${index}`, index))));

        // Assert
        expect(outcomes.map((outcome) => outcome.result)).toEqual(['applied', 'applied']);
        expect([...nodes.values()].flatMap((node) => node.owned())).toEqual([address]);
    });
});
