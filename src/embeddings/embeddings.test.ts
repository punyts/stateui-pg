import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { pgWorkspaceStorage } from '../workspace/PgWorkspaceStorage.js';
import { hashEmbedder } from './Embedder.js';
import { EmbeddingIndex } from './EmbeddingIndex.js';
import { PART_SOURCE, partSearchText, partSource } from './partText.js';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';

let test: TestDatabase;
let index: EmbeddingIndex;

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
    index = new EmbeddingIndex(test.db, hashEmbedder(256), { [PART_SOURCE]: partSource });
});

afterAll(async () => {
    await index.stop();
    await test.drop();
});

const appBody = (title: string, fields: string[]): never =>
    ({
        home: 'home',
        screens: {
            home: {
                root: {
                    component: 'column',
                    children: { title: { component: 'heading', text: title }, ...Object.fromEntries(fields.map((field) => [field, { component: 'textField', label: field }])) }
                }
            }
        }
    }) as never;

describe('partSearchText', () => {
    it('should give the kind, the name and the words of the body once, without colours or paths', () => {
        // Act
        const text = partSearchText('apps', 'customer-orders', {
            screens: { home: { root: { component: 'column', children: { title: { component: 'heading', text: 'Orders' }, color: '#ff0000', shippingAddress: { label: 'Orders' } } } } }
        });

        // Assert
        expect(text.split('\n')[0]).toBe('app customer orders');
        expect(text).toContain('Orders');
        expect(text).toContain('shipping Address');
        expect(text).not.toContain('#ff0000');
        expect(text.match(/Orders/g)).toHaveLength(1);
    });
});

describe('EmbeddingIndex', () => {
    it('should queue a part on write, find it by meaning in its own workspace, and follow its changes', async () => {
        // Arrange
        const alice = pgWorkspaceStorage(test.db, ALICE, { embedParts: true });
        const bob = pgWorkspaceStorage(test.db, BOB, { embedParts: true });
        const orders = await alice.parts.create({ kind: 'apps', name: 'customer-orders', body: appBody('Customer orders', ['customer', 'order total', 'shipping address']) });
        await alice.parts.create({ kind: 'apps', name: 'weather', body: appBody('Weather today', ['temperature', 'wind', 'rain']) });
        await bob.parts.create({ kind: 'apps', name: 'orders-too', body: appBody('Customer orders', ['customer', 'order total']) });

        // Act
        const queued = Number((await test.db.query<{ n: number }>('SELECT count(*)::int AS n FROM embedding_job')).rows[0]?.n);
        await index.drain();
        const hits = await index.search({ workspaceIds: [ALICE], sourceKind: PART_SOURCE, query: 'orders of customers' });
        const id = orders.kind === 'created' ? orders.part.id : '';
        await alice.parts.write('apps', 'customer-orders', appBody('Rain gauge', ['rain', 'wind']), 1);
        await index.drain();
        const afterWrite = await index.search({ workspaceIds: [ALICE], sourceKind: PART_SOURCE, query: 'rain wind', limit: 1 });
        await alice.parts.delete('apps', 'weather', 1);
        await index.drain();
        const afterDelete = await index.search({ workspaceIds: [ALICE], sourceKind: PART_SOURCE, query: 'weather temperature' });

        // Assert
        expect(queued).toBe(3);
        expect(hits.map((hit) => hit.sourceId)).toEqual([`apps/${id}`, expect.stringMatching(/^apps\//)]);
        expect(hits.every((hit) => hit.workspaceId === ALICE)).toBe(true);
        expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
        expect(afterWrite[0]?.sourceId).toBe(`apps/${id}`);
        expect(afterDelete.map((hit) => hit.sourceId)).toEqual([`apps/${id}`]);
    });

    it("should compare only vectors of the search's model, and skip a source whose text did not change", async () => {
        // Arrange
        await test.db.transaction(
            async (tx) => {
                await tx.query(
                    "INSERT INTO embedding (workspace_id, source_kind, source_id, model, embedding, source_hash) VALUES ($1, 'part', 'apps/other-model', 'another-model', $2::vector, 'x')",
                    [ALICE, `[${new Array(256).fill(0.1).join(',')}]`]
                );
            },
            { workspaceIds: [ALICE] }
        );
        const stamp = async (): Promise<string> =>
            await test.db.transaction(async (tx) => (await tx.query<{ at: string }>("SELECT max(updated_at)::text AS at FROM embedding WHERE model = 'hash-256'")).rows[0]?.at ?? '', {
                workspaceIds: [ALICE]
            });
        const before = await stamp();

        // Act
        const hits = await index.search({ workspaceIds: [ALICE], sourceKind: PART_SOURCE, query: 'anything at all', limit: 50 });
        await test.db.transaction(
            async (tx) => {
                await tx.query("INSERT INTO embedding_job (workspace_id, source_kind, source_id) SELECT workspace_id, source_kind, source_id FROM embedding WHERE model = 'hash-256'");
            },
            { workspaceIds: [ALICE] }
        );
        await index.drain();
        const after = await stamp();
        const pgIndex = (await test.db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'embedding_hnsw_%'")).rows[0]?.n;

        // Assert
        expect(hits.map((hit) => hit.sourceId)).not.toContain('apps/other-model');
        expect(pgIndex).toBe(1);
        expect(after).toBe(before);
    });
});
