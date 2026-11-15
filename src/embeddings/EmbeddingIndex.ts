import { createHash } from 'node:crypto';
import type { Database, Queryable } from '../db/Database.js';
import type { Embedder } from './Embedder.js';

/** One thing to embed: a source of a kind in a workspace, and a field of it when a source has several */
export interface EmbeddingJob {
    readonly workspaceId: string;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly field?: string;
}

/** The text of a source as it is now, and whose it is when it is one person's; `undefined` when it is gone */
export interface SourceText {
    readonly text: string;
    readonly owner?: string;
}

/** Reads the text of one source of a kind, in a transaction set to its workspace */
export type EmbeddingSource = (tx: Queryable, job: Required<EmbeddingJob>) => Promise<SourceText | undefined>;

export interface EmbeddingHit {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly field: string;
    /** Cosine similarity, 1 for the same direction */
    readonly score: number;
}

export interface EmbeddingSearch {
    /** The workspaces searched: the ones the person may open */
    readonly workspaceIds: readonly string[];
    readonly sourceKind: string;
    readonly query: string;
    readonly limit?: number;
    /** Only one person's own sources (their chats) */
    readonly owner?: string;
    /** Only these sources */
    readonly sourceIds?: readonly string[];
    /** Only the sources whose id starts with this, such as one dataset's records */
    readonly sourcePrefix?: string;
    /** Only this field of each source (a record field) */
    readonly field?: string;
}

/** Adds a job in the transaction given, so it commits with the write that called for it */
export async function enqueueEmbedding(tx: Queryable, job: EmbeddingJob): Promise<void> {
    await tx.query('INSERT INTO embedding_job (workspace_id, source_kind, source_id, field) VALUES ($1, $2, $3, $4)', [job.workspaceId, job.sourceKind, job.sourceId, job.field ?? '']);
}

const MAX_ATTEMPTS = 5;
const hashOf = (text: string): string => createHash('sha256').update(text).digest('base64url');
const literal = (vector: readonly number[]): string => `[${vector.join(',')}]`;

/**
 * The vectors of a server's searchable sources (`embedding`) and the worker that makes them from the queue
 * (`embedding_job`). A write never waits for its embedding: it adds a job, and `work` takes jobs with SKIP LOCKED,
 * reads each source's text as it is now (dropping the job when nothing changed), embeds in batches, and stores the
 * vectors under the embedder's model. A search embeds the query with the same model and compares only that model's
 * vectors, in the workspaces given, through the model's own index
 */
export class EmbeddingIndex {
    private timer: NodeJS.Timeout | undefined;
    private running: Promise<number> | undefined;
    private indexed: Promise<void> | undefined;

    constructor(
        private readonly db: Database,
        readonly embedder: Embedder,
        private readonly sources: Readonly<Record<string, EmbeddingSource>>,
        private readonly options: { readonly batch?: number; readonly report?: (message: string, fields: Record<string, unknown>) => void } = {}
    ) {
        if (!/^[A-Za-z0-9._/-]{1,200}$/.test(embedder.model)) throw new Error('An embedding model id is letters, digits, dots, dashes, underscores and slashes');
        if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1 || embedder.dimensions > 2000) throw new Error('An embedding has 1 to 2000 dimensions');
    }

    /** Makes the model's HNSW index when it has none: over the vectors cast to its size, for its rows only */
    ensureIndex(): Promise<void> {
        this.indexed ??= (async () => {
            const name = `embedding_hnsw_${createHash('sha256').update(this.embedder.model).digest('hex').slice(0, 16)}`;
            await this.db.query(
                `CREATE INDEX IF NOT EXISTS ${name} ON embedding USING hnsw ((embedding::vector(${this.embedder.dimensions})) vector_cosine_ops) WHERE model = '${this.embedder.model}'`
            );
        })().catch((error: unknown) => {
            this.indexed = undefined;
            throw error;
        });
        return this.indexed;
    }

    /** Adds a job outside any other write */
    async enqueue(job: EmbeddingJob): Promise<void> {
        await enqueueEmbedding(this.db, job);
    }

    /** Embeds what is waiting, one batch; answers how many jobs it took */
    work(): Promise<number> {
        this.running ??= this.workOnce().finally(() => (this.running = undefined));
        return this.running;
    }

    /** Works the queue until it is empty */
    async drain(): Promise<void> {
        while ((await this.work()) > 0) {
            // keep going
        }
    }

    /** Works the queue every `intervalMs` until `stop` */
    start(intervalMs = 2000): void {
        if (this.timer !== undefined) return;
        const tick = (): void => {
            this.work()
                .catch((error: unknown) => this.options.report?.('Embedding failed', { reason: error instanceof Error ? error.message : String(error) }))
                .finally(() => {
                    if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
                });
        };
        this.timer = setTimeout(tick, intervalMs);
    }

    async stop(): Promise<void> {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        await this.running?.catch(() => undefined);
    }

    async search(search: EmbeddingSearch): Promise<EmbeddingHit[]> {
        if (search.workspaceIds.length === 0 || search.query.trim() === '') return [];
        await this.ensureIndex();
        const [query] = await this.embedder.embed([search.query], 'query');
        if (query === undefined) return [];
        const dims = this.embedder.dimensions;
        const params: unknown[] = [literal(query), this.embedder.model, search.sourceKind, search.workspaceIds, Math.min(Math.max(search.limit ?? 10, 1), 100)];
        let filter = '';
        if (search.owner !== undefined) {
            params.push(search.owner);
            filter += ` AND owner = $${params.length}`;
        }
        if (search.sourceIds !== undefined) {
            params.push(search.sourceIds);
            filter += ` AND source_id = ANY($${params.length}::text[])`;
        }
        if (search.sourcePrefix !== undefined) {
            params.push(search.sourcePrefix.length, search.sourcePrefix);
            filter += ` AND left(source_id, $${params.length - 1}) = $${params.length}`;
        }
        if (search.field !== undefined) {
            params.push(search.field);
            filter += ` AND field = $${params.length}`;
        }
        return this.db.transaction(
            async (tx) =>
                (
                    await tx.query<{ workspace_id: string; source_id: string; field: string; distance: number }>(
                        `SELECT workspace_id, source_id, field, (embedding::vector(${dims})) <=> ($1::vector(${dims})) AS distance
                           FROM embedding
                          WHERE model = $2 AND source_kind = $3 AND workspace_id = ANY($4::uuid[])${filter}
                          ORDER BY (embedding::vector(${dims})) <=> ($1::vector(${dims}))
                          LIMIT $5`,
                        params
                    )
                ).rows.map((row) => ({ workspaceId: row.workspace_id, sourceId: row.source_id, field: row.field, score: 1 - row.distance })),
            { workspaceIds: search.workspaceIds }
        );
    }

    private async workOnce(): Promise<number> {
        await this.ensureIndex();
        const jobs = (
            await this.db.query<{ id: number; workspace_id: string; source_kind: string; source_id: string; field: string; attempts: number }>(
                `DELETE FROM embedding_job WHERE id IN (SELECT id FROM embedding_job ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
                 RETURNING id, workspace_id, source_kind, source_id, field, attempts`,
                [this.options.batch ?? 32]
            )
        ).rows;
        if (jobs.length === 0) return 0;
        // A source queued twice is embedded once
        const unique = new Map<string, (typeof jobs)[number]>();
        for (const job of jobs) unique.set(`${job.workspace_id}/${job.source_kind}/${job.source_id}/${job.field}`, job);
        const pending: Array<{ job: (typeof jobs)[number]; text: string; owner: string; hash: string }> = [];
        for (const job of unique.values()) {
            try {
                const read = this.sources[job.source_kind];
                const key = { workspaceId: job.workspace_id, sourceKind: job.source_kind, sourceId: job.source_id, field: job.field };
                const found = read === undefined ? undefined : await this.db.transaction((tx) => read(tx, key), { workspaceIds: [job.workspace_id] });
                if (found === undefined || found.text.trim() === '') {
                    await this.forget(job.workspace_id, job.source_kind, job.source_id, job.field);
                    continue;
                }
                const hash = hashOf(found.text);
                const current = await this.db.transaction(
                    async (tx) =>
                        (
                            await tx.query<{ source_hash: string }>('SELECT source_hash FROM embedding WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3 AND field = $4 AND model = $5', [
                                job.workspace_id,
                                job.source_kind,
                                job.source_id,
                                job.field,
                                this.embedder.model
                            ])
                        ).rows[0]?.source_hash,
                    { workspaceIds: [job.workspace_id] }
                );
                if (current !== hash) pending.push({ job, text: found.text.slice(0, 8000), owner: found.owner ?? '', hash });
            } catch (error) {
                await this.retry(job, error);
            }
        }
        if (pending.length > 0) {
            let vectors: number[][];
            try {
                vectors = await this.embedder.embed(
                    pending.map((entry) => entry.text),
                    'document'
                );
            } catch (error) {
                for (const entry of pending) await this.retry(entry.job, error);
                return jobs.length;
            }
            for (const [index, entry] of pending.entries()) {
                const vector = vectors[index];
                if (vector === undefined || vector.length !== this.embedder.dimensions) continue;
                await this.db.transaction(
                    async (tx) => {
                        await tx.query(
                            `INSERT INTO embedding (workspace_id, source_kind, source_id, field, owner, model, embedding, source_hash, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, now())
                             ON CONFLICT (workspace_id, source_kind, source_id, field, model) DO UPDATE SET owner = EXCLUDED.owner, embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, updated_at = now()`,
                            [entry.job.workspace_id, entry.job.source_kind, entry.job.source_id, entry.job.field, entry.owner, this.embedder.model, literal(vector), entry.hash]
                        );
                    },
                    { workspaceIds: [entry.job.workspace_id] }
                );
            }
        }
        return jobs.length;
    }

    /** Removes the vectors of a source that is gone, in every model */
    private async forget(workspaceId: string, sourceKind: string, sourceId: string, field: string): Promise<void> {
        await this.db.transaction(
            async (tx) => {
                await tx.query('DELETE FROM embedding WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3 AND field = $4', [workspaceId, sourceKind, sourceId, field]);
            },
            { workspaceIds: [workspaceId] }
        );
    }

    private async retry(job: { workspace_id: string; source_kind: string; source_id: string; field: string; attempts: number }, error: unknown): Promise<void> {
        this.options.report?.('Embedding job failed', {
            sourceKind: job.source_kind,
            sourceId: job.source_id,
            attempts: job.attempts + 1,
            reason: error instanceof Error ? error.message : String(error)
        });
        if (job.attempts + 1 >= MAX_ATTEMPTS) return;
        await this.db.query('INSERT INTO embedding_job (workspace_id, source_kind, source_id, field, attempts) VALUES ($1, $2, $3, $4, $5)', [
            job.workspace_id,
            job.source_kind,
            job.source_id,
            job.field,
            job.attempts + 1
        ]);
    }
}
