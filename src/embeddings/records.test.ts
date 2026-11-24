import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datasetStateAddress, seededDataset } from '@punyts/stateui-mcp';
import type { ServicesStorage, UiPartBodies } from '@punyts/stateui-mcp';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { pgWorkspaceStorage } from '../workspace/PgWorkspaceStorage.js';
import { hashEmbedder } from './Embedder.js';
import { EmbeddingIndex } from './EmbeddingIndex.js';
import { changedRecordFields, embeddedFields, PERSON_RECORD_SOURCE, personRecordSource, queueAllRecords, RECORD_SOURCE, recordSource } from './records.js';
import { RecordSimilarity } from './RecordSimilarity.js';

const WORKSPACE = 'c0000000-0000-4000-8000-000000000003';
const APP = 'd0000000-0000-4000-8000-000000000004';
/** The tickets dataset's namespace */
const TICKETS_ADDRESS = datasetStateAddress(WORKSPACE, 'tickets');

const TICKET_MODEL = { fields: { title: { type: 'string', embed: true }, notes: { type: 'string', embed: true }, status: { type: 'string' } } } as unknown as UiPartBodies['models'];
const TICKET_RECORDS = {
    t1: { title: 'Printer jams on every page', notes: 'paper stuck in the tray', status: 'open' },
    t2: { title: 'Password reset email never arrives', notes: 'login account email', status: 'open' },
    t3: { title: 'Laptop battery drains overnight', notes: 'power battery charge', status: 'closed' }
};
const APP_BODY = { uses: { data: { tickets: { dataset: 'tickets' }, mine: { model: 'ticket', scope: 'person' } } }, start: 'home', screens: { home: { root: { component: 'panel' } } } } as unknown as UiPartBodies['apps'];

let test: TestDatabase;
let storage: ServicesStorage;
let index: EmbeddingIndex;
let similarity: RecordSimilarity;

const jobs = async (): Promise<Array<{ source_kind: string; source_id: string; field: string }>> =>
    (await test.db.query<{ source_kind: string; source_id: string; field: string }>('SELECT source_kind, source_id, field FROM embedding_job ORDER BY source_id, field')).rows;
const place = (person: string) => ({ workspaceId: WORKSPACE, parts: storage.parts, appId: APP, person });

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
    storage = pgWorkspaceStorage(test.db, WORKSPACE, { embedRecords: true });
    index = new EmbeddingIndex(test.db, hashEmbedder(256), { [RECORD_SOURCE]: recordSource, [PERSON_RECORD_SOURCE]: personRecordSource });
    similarity = new RecordSimilarity(index);
    await storage.parts.create({ kind: 'models', name: 'ticket', body: TICKET_MODEL });
    await storage.parts.create({ kind: 'data', name: 'tickets', body: { model: 'ticket' } as unknown as UiPartBodies['data'] });
    await storage.datasets.save(TICKETS_ADDRESS, seededDataset(TICKET_RECORDS), 0);
    await storage.parts.create({ kind: 'apps', name: 'helpdesk', id: APP, body: APP_BODY });
});

afterAll(async () => {
    await index.stop();
    await test.drop();
});

describe('embeddedFields and changedRecordFields', () => {
    it('should take only string fields that say embed: true', () => {
        expect(embeddedFields({ fields: { a: { type: 'string', embed: true }, b: { type: 'number', embed: true }, c: { type: 'string' } } })).toEqual(['a']);
    });

    it('should name each added, changed and removed record field', () => {
        expect(changedRecordFields({ a: { x: '1', y: '1' }, b: { x: '1' } }, { a: { x: '2', y: '1' }, c: { x: '3' } }, ['x', 'y'])).toEqual([
            ['a', 'x'],
            ['b', 'x'],
            ['c', 'x']
        ]);
    });
});

describe('Record embeddings and similar', () => {
    it('should answer similar over a dataset with the keys of the closest records', async () => {
        // Arrange
        await index.drain();

        // Act
        const answer = await similarity.similar(place('alice'), { binding: 'tickets', field: 'title', text: 'printer jams', limit: 2 });

        // Assert
        expect(answer.kind).toBe('found');
        if (answer.kind !== 'found') return;
        expect(answer.results).toHaveLength(2);
        expect(answer.results[0]?.key).toBe('t1');
        expect(answer.results[0]?.score).toBeGreaterThan(answer.results[1]?.score ?? 1);
    });

    it('should queue only the record and field an edit changes', async () => {
        // Arrange
        await index.drain();
        const stored = await storage.datasets.load(TICKETS_ADDRESS);
        const state = structuredClone(stored?.state) as unknown as { data: { records: Record<string, Record<string, string>> } };
        (state.data.records['t2'] as Record<string, string>)['notes'] = 'single sign on';
        (state.data.records['t3'] as Record<string, string>)['status'] = 'open';

        // Act
        await storage.datasets.save(TICKETS_ADDRESS, { ...seededDataset(state.data.records), revision: (stored?.revision ?? 0) + 1 }, 0);

        // Assert
        expect(await jobs()).toEqual([{ source_kind: RECORD_SOURCE, source_id: `${TICKETS_ADDRESS}/t2`, field: 'notes' }]);
        await index.drain();
    });

    it("should search a person binding's records of that person only", async () => {
        // Arrange
        await storage.instances('alice').writeData(APP, 'mine', { model: 'ticket', records: { a1: { title: 'Monitor flickers', notes: '', status: 'open' } } } as never);
        await storage.instances('bob').writeData(APP, 'mine', { model: 'ticket', records: { b1: { title: 'Monitor flickers badly', notes: '', status: 'open' } } } as never);
        await index.drain();

        // Act
        const alice = await similarity.similar(place('alice'), { binding: 'mine', field: 'title', text: 'monitor flickers' });
        const bob = await similarity.similar(place('bob'), { binding: 'mine', field: 'title', text: 'monitor flickers' });

        // Assert
        expect(alice.kind === 'found' && alice.results.map((found) => found.key)).toEqual(['a1']);
        expect(bob.kind === 'found' && bob.results.map((found) => found.key)).toEqual(['b1']);
    });

    it('should refuse a field the model does not embed, and a binding the app does not have', async () => {
        expect(await similarity.similar(place('alice'), { binding: 'tickets', field: 'status', text: 'open' })).toEqual({
            kind: 'refused',
            reason: 'the field "status" of the model "ticket" is not a string field with embed: true'
        });
        expect((await similarity.similar(place('alice'), { binding: 'other', field: 'title', text: 'x' })).kind).toBe('refused');
    });

    it('should queue every record of the model when a field starts to be embedded, and forget it when it stops', async () => {
        // Arrange
        await index.drain();
        const model = await storage.parts.findByName('models', 'ticket');
        const embedded = { fields: { ...TICKET_MODEL.fields, status: { type: 'string', embed: true } } } as unknown as UiPartBodies['models'];

        // Act
        await storage.parts.write('models', 'ticket', embedded, model?.revision ?? 0);
        const queued = await jobs();
        await index.drain();
        const found = await similarity.similar(place('alice'), { binding: 'tickets', field: 'status', text: 'closed' });
        await storage.parts.write('models', 'ticket', TICKET_MODEL, (model?.revision ?? 0) + 1);
        await index.drain();
        const left = await test.db.query<{ count: number | string }>("SELECT count(*) AS count FROM embedding WHERE field = 'status'");

        // Assert
        expect(queued.filter((job) => job.field === 'status').map((job) => job.source_id.split('/').pop()).sort()).toEqual(['a1', 'b1', 't1', 't2', 't3']);
        expect(found.kind === 'found' && found.results.length).toBe(3);
        expect(Number(left.rows[0]?.count)).toBe(0);
    });

    it('should queue every embedded field of every record for a reindex', async () => {
        // Arrange
        await index.drain();

        // Act
        await queueAllRecords(test.db);

        // Assert: three dataset records and two person records, two embedded fields each
        const queued = await jobs();
        expect(queued.filter((job) => job.source_kind === RECORD_SOURCE)).toHaveLength(6);
        expect(queued.filter((job) => job.source_kind === PERSON_RECORD_SOURCE)).toHaveLength(4);
        await index.drain();
    });
});
