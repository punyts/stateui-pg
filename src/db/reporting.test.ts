import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addListener, clearListeners, setCategories } from '@punyts/core';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { lockKey } from '../workspace/WorkspaceDb.js';
import { statementName } from './Database.js';
import { migrate } from './migrate.js';

interface Line {
    readonly category: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
}

const SECRET = 'secret@value.test';

let test: TestDatabase;
let dir: string;
let lines: Line[];

beforeEach(async () => {
    test = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    lines = [];
    setCategories(['stateui-pg.*']);
    addListener((_timestamp, category, message, details) => lines.push({ category, message, details: details as Record<string, unknown> }), ['stateui-pg.*']);
});

afterEach(async () => {
    setCategories(['info', 'error', 'stack']);
    clearListeners();
    await test.drop();
});

describe('reporting', () => {
    it('should report migrations, queries, transactions and locks under stateui-pg.*, with names, counts and durations and no value', async () => {
        // Arrange
        await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id integer PRIMARY KEY, note text);');
        const workspaceId = randomUUID();

        // Act
        await migrate(test.db, [{ owner: 'test', dir }]);
        await test.db.transaction(async (tx) => {
            await lockKey(tx, `files:${workspaceId}:app`);
            await tx.query('INSERT INTO thing (id, note) VALUES ($1, $2)', [1, SECRET]);
        }, { workspaceIds: [workspaceId] });
        await test.db.query('SELECT note FROM thing WHERE note = $1', [SECRET]);
        await expect(test.db.transaction(async (tx) => tx.query('INSERT INTO thing (id, note) VALUES ($1, $2)', [1, SECRET]))).rejects.toThrow();

        // Assert
        expect(lines).toContainEqual({ category: 'stateui-pg.migrate', message: 'Migration applied', details: { owner: 'test', version: 1, name: 'thing', ms: expect.any(Number) } });
        expect(lines).toContainEqual({ category: 'stateui-pg.transaction', message: 'Transaction begun', details: { workspaceIds: [workspaceId] } });
        expect(lines).toContainEqual({ category: 'stateui-pg.lock', message: 'Lock held', details: { lock: 'files', ms: expect.any(Number) } });
        expect(lines).toContainEqual({ category: 'stateui-pg.query', message: 'Query', details: { statement: 'INSERT', table: 'thing', rows: 1, ms: expect.any(Number), inTransaction: true } });
        expect(lines).toContainEqual({ category: 'stateui-pg.transaction', message: 'Transaction committed', details: { workspaceIds: [workspaceId], queries: 2, ms: expect.any(Number) } });
        expect(lines).toContainEqual({ category: 'stateui-pg.query', message: 'Query', details: { statement: 'SELECT', table: 'thing', rows: 1, ms: expect.any(Number), inTransaction: false } });
        expect(lines).toContainEqual({ category: 'stateui-pg.query', message: 'Query failed', details: { statement: 'INSERT', table: 'thing', code: '23505', ms: expect.any(Number), inTransaction: true } });
        expect(lines).toContainEqual({ category: 'stateui-pg.transaction', message: 'Transaction rolled back', details: { workspaceIds: [], queries: 1, code: '23505', ms: expect.any(Number) } });
        expect(JSON.stringify(lines)).not.toContain(SECRET);
    });

    it('should name a statement by its kind and first table, and nothing of its values', () => {
        // Arrange
        const sql = "UPDATE part SET body = $1 WHERE workspace_id = $2 AND name = 'x'";

        // Act
        const named = statementName(sql);

        // Assert
        expect(named).toEqual({ statement: 'UPDATE', table: 'part' });
        expect(statementName('  select 1')).toEqual({ statement: 'SELECT' });
    });
});
