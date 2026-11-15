import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { CatalogEmbeddings } from './CatalogEmbeddings.js';
import { hashEmbedder } from './Embedder.js';
import type { Embedder } from './Embedder.js';

const ENTRIES = [
    { name: 'dateRangeField', text: 'date range field. Two dates. For: choose start and end dates; booking a stay.' },
    { name: 'colorField', text: 'color field. Pick a colour. For: choose a colour; brand colour.' },
    { name: 'kanbanBoard', text: 'kanban board. Cards in columns. For: track tasks by stage; drag cards between lanes.' }
];

let test: TestDatabase;

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
});

afterAll(async () => {
    await test.drop();
});

/** The hash embedder, counting the texts it embeds */
function counted(): { embedder: Embedder; texts: () => number } {
    const inner = hashEmbedder(256);
    let texts = 0;
    return {
        embedder: { ...inner, embed: (input, purpose) => ((texts += purpose === 'document' ? input.length : 0), inner.embed(input, purpose)) },
        texts: () => texts
    };
}

describe('CatalogEmbeddings', () => {
    it('should rank the entries by meaning, best first, closest above the close score', async () => {
        // Arrange
        const catalog = new CatalogEmbeddings(test.db, hashEmbedder(256), { closeScore: 0.2 });

        // Act
        const ranking = await catalog.rank('component', 'drag tasks between lanes', ENTRIES, 2);

        // Assert
        expect(ranking?.ranked).toEqual(['kanbanBoard', expect.any(String)]);
        expect(ranking?.close).toBe(true);
    });

    it('should not call a far best match close', async () => {
        const catalog = new CatalogEmbeddings(test.db, hashEmbedder(256), { closeScore: 0.99 });

        expect((await catalog.rank('component', 'drag tasks between lanes', ENTRIES, 3))?.close).toBe(false);
    });

    it('should embed a set of entries once, for every server on the database, and again only when a text changes', async () => {
        // Arrange
        const first = counted();
        const second = counted();
        await new CatalogEmbeddings(test.db, first.embedder).rank('pattern', 'a need', ENTRIES, 3);

        // Act
        await new CatalogEmbeddings(test.db, second.embedder).rank('pattern', 'a need', ENTRIES, 3);
        const before = second.texts();
        await new CatalogEmbeddings(test.db, second.embedder).rank('pattern', 'a need', [{ ...(ENTRIES[0] as (typeof ENTRIES)[number]), text: 'changed' }, ...ENTRIES.slice(1)], 3);

        // Assert
        expect(first.texts()).toBe(3);
        expect(before).toBe(0);
        expect(second.texts()).toBe(3);
        const versions = await test.db.query<{ count: string | number }>("SELECT count(DISTINCT catalog_version) AS count FROM catalog_embedding WHERE entry_kind = 'pattern'");
        expect(Number(versions.rows[0]?.count)).toBe(1);
    });

    it('should never compare vectors of another model', async () => {
        // Arrange
        await new CatalogEmbeddings(test.db, hashEmbedder(256)).rank('component', 'colour', ENTRIES, 3);
        const other = hashEmbedder(128);
        const embed = vi.fn(other.embed);

        // Act
        const ranking = await new CatalogEmbeddings(test.db, { ...other, embed }).rank('component', 'colour', ENTRIES, 3);

        // Assert
        expect(embed).toHaveBeenCalledWith(ENTRIES.map((entry) => entry.text), 'document');
        expect(ranking?.ranked).toHaveLength(3);
    });

    it('should answer nothing for an empty need', async () => {
        expect(await new CatalogEmbeddings(test.db, hashEmbedder(256)).rank('component', '  ', ENTRIES, 3)).toBeUndefined();
    });
});
