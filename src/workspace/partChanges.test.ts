import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { listenToPartChanges } from './PgPartChanges.js';
import type { PartNotice } from './PgPartChanges.js';
import { pgWorkspaceStorage } from './PgWorkspaceStorage.js';

const WORKSPACE = 'c0000000-0000-4000-8000-00000000000c';
let test: TestDatabase;

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
});

afterAll(async () => {
    await test.drop();
});

describe('part changes across servers', () => {
    it("should tell a server of every part change another server makes (the old name of a rename too), and not of its own", async () => {
        // Arrange: two servers on one database
        const one = pgWorkspaceStorage(test.db, WORKSPACE, { announceAs: 'server-1' });
        const two = pgWorkspaceStorage(test.db, WORKSPACE, { announceAs: 'server-2' });
        const heardByOne: PartNotice[] = [];
        const listening = await listenToPartChanges(test.db, 'server-1', (notice) => heardByOne.push(notice));

        // Act
        const made = await two.parts.create({ kind: 'models', name: 'note', body: { fields: { text: { type: 'string' } } } as never });
        if (made.kind !== 'created') throw new Error(made.kind);
        await two.parts.write('models', 'note', { fields: { text: { type: 'string' }, done: { type: 'boolean' } } } as never, made.part.revision);
        await two.parts.rename('models', 'note', 'task');
        await one.parts.create({ kind: 'models', name: 'own', body: { fields: {} } as never });
        const task = await two.parts.findByName('models', 'task');
        await two.parts.delete('models', 'task', task?.revision ?? 0);

        // Assert
        await vi.waitFor(() => expect(heardByOne.map((notice) => notice.name)).toEqual(['note', 'note', 'task', 'note', 'task']));
        expect(heardByOne.every((notice) => notice.workspaceId === WORKSPACE && notice.kind === 'models')).toBe(true);
        await listening.close();
    });

    it('should announce nothing for a server that does not name itself', async () => {
        // Arrange
        const quiet = pgWorkspaceStorage(test.db, WORKSPACE);
        const heard: PartNotice[] = [];
        const listening = await listenToPartChanges(test.db, 'listener', (notice) => heard.push(notice));

        // Act
        await quiet.parts.create({ kind: 'models', name: 'silent', body: { fields: {} } as never });
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Assert
        expect(heard).toEqual([]);
        await listening.close();
    });
});
