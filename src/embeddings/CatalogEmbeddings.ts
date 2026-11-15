import { createHash } from 'node:crypto';
import type { Database } from '../db/Database.js';
import { LOCAL_MODEL } from './Embedder.js';
import type { Embedder } from './Embedder.js';

/** One library entry as it is embedded (the shape of `CatalogText` in `@punyts/stateui-mcp`) */
export interface CatalogEntryText {
    readonly name: string;
    readonly text: string;
}

/** The entries closest in meaning to a need, best first, and whether the best is close enough to rely on */
export interface CatalogRanking {
    readonly ranked: readonly string[];
    readonly close: boolean;
}

/**
 * The similarity at which a model's best match is close: a need and an entry that mean the same thing. Each model has
 * its own; a model not listed uses `DEFAULT_CLOSE_SCORE`
 */
export const CLOSE_SCORES: Readonly<Record<string, number>> = { [LOCAL_MODEL]: 0.45 };
export const DEFAULT_CLOSE_SCORE = 0.5;

const literal = (vector: readonly number[]): string => `[${vector.join(',')}]`;

/**
 * The component library's components and patterns by meaning (`catalog_embedding`), for `ui_components_search` and
 * `ui_patterns_search` when their keywords come back weak. It implements the `CatalogMeanings` port of
 * `@punyts/stateui-mcp`. The entries come with each call; a set is embedded once per version (the hash of its kind and
 * texts) and model, and stored for every server on the database, so a restart does not embed it again
 */
export class CatalogEmbeddings {
    private readonly ready = new Map<string, Promise<void>>();
    private readonly closeScore: number;
    private readonly batch: number;

    constructor(
        private readonly db: Database,
        private readonly embedder: Embedder,
        options: { readonly closeScore?: number; readonly batch?: number } = {}
    ) {
        this.closeScore = options.closeScore ?? CLOSE_SCORES[embedder.model] ?? DEFAULT_CLOSE_SCORE;
        this.batch = options.batch ?? 32;
    }

    async rank(kind: string, need: string, entries: readonly CatalogEntryText[], limit: number): Promise<CatalogRanking | undefined> {
        if (need.trim() === '' || entries.length === 0) return undefined;
        const version = versionOf(kind, entries);
        await this.ensure(kind, version, entries);
        const [query] = await this.embedder.embed([need], 'query');
        if (query === undefined) return undefined;
        const dims = this.embedder.dimensions;
        const rows = (
            await this.db.query<{ name: string; distance: number }>(
                `SELECT name, (embedding::vector(${dims})) <=> ($1::vector(${dims})) AS distance
                   FROM catalog_embedding
                  WHERE catalog_version = $2 AND entry_kind = $3 AND model = $4
                  ORDER BY distance, name
                  LIMIT $5`,
                [literal(query), version, kind, this.embedder.model, Math.min(Math.max(Math.trunc(limit), 1), 100)]
            )
        ).rows;
        const best = rows[0];
        if (best === undefined) return undefined;
        return { ranked: rows.map((row) => row.name), close: 1 - best.distance >= this.closeScore };
    }

    /** Embeds the entries of a version that are not stored yet, and removes the kind's older versions of this model */
    private ensure(kind: string, version: string, entries: readonly CatalogEntryText[]): Promise<void> {
        const key = `${kind}/${version}`;
        let ready = this.ready.get(key);
        if (ready === undefined) {
            ready = this.store(kind, version, entries).catch((error: unknown) => {
                this.ready.delete(key);
                throw error;
            });
            this.ready.set(key, ready);
        }
        return ready;
    }

    private async store(kind: string, version: string, entries: readonly CatalogEntryText[]): Promise<void> {
        const model = this.embedder.model;
        const stored = new Set(
            (await this.db.query<{ name: string }>('SELECT name FROM catalog_embedding WHERE catalog_version = $1 AND entry_kind = $2 AND model = $3', [version, kind, model])).rows.map(
                (row) => row.name
            )
        );
        const missing = entries.filter((entry) => !stored.has(entry.name));
        for (let start = 0; start < missing.length; start += this.batch) {
            const chunk = missing.slice(start, start + this.batch);
            const vectors = await this.embedder.embed(
                chunk.map((entry) => entry.text),
                'document'
            );
            await this.db.transaction(async (tx) => {
                for (const [index, entry] of chunk.entries()) {
                    const vector = vectors[index];
                    if (vector === undefined || vector.length !== this.embedder.dimensions) throw new Error(`The embedder gave no ${this.embedder.dimensions}-dimension vector for ${entry.name}`);
                    await tx.query(
                        'INSERT INTO catalog_embedding (catalog_version, entry_kind, name, model, embedding) VALUES ($1, $2, $3, $4, $5::vector) ON CONFLICT DO NOTHING',
                        [version, kind, entry.name, model, literal(vector)]
                    );
                }
            });
        }
        await this.db.query('DELETE FROM catalog_embedding WHERE entry_kind = $1 AND model = $2 AND catalog_version <> $3', [kind, model, version]);
    }
}

/** A set of entries' version: the hash of the kind and each name and text, in order */
function versionOf(kind: string, entries: readonly CatalogEntryText[]): string {
    const hash = createHash('sha256').update(kind);
    for (const entry of entries) hash.update(`\u0000${entry.name}\u0000${entry.text}`);
    return hash.digest('base64url').slice(0, 22);
}
