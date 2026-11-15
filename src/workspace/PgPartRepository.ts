import { randomUUID } from 'node:crypto';
import { createUiPart, isAppId, isPartBody, isPartKind, isRevisionCurrent, PART_BODY_PROBLEM, PART_ID_PROBLEM, PART_ID_TAKEN, partInputProblem, partNameProblem, renameUiPart, reviseUiPart } from '@punyts/stateui-mcp';
import { PART_CHANNEL, partNotice } from './PgPartChanges.js';
import type {
    CreateUiPartInput,
    CreateUiPartResult,
    PartKind,
    UiPart,
    UiPartBodies,
    UiPartDeleteResult,
    UiPartRenameResult,
    UiPartRepository,
    UiPartRewrite,
    UiPartRewritten,
    UiPartSummary,
    UiPartWriteResult
} from '@punyts/stateui-mcp';
import { isUniqueViolation } from '../db/Database.js';
import type { Queryable } from '../db/Database.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

interface PartRow {
    id: string;
    kind: PartKind;
    name: string;
    revision: number;
    body: object;
    created_at: Date;
    updated_at: Date;
}

const COLUMNS = 'id, kind, name, revision, body, created_at, updated_at';

function toPart<K extends PartKind>(row: PartRow): UiPart<K> {
    return { id: row.id, kind: row.kind as K, name: row.name, revision: row.revision, body: row.body as UiPartBodies[K], createdAt: row.created_at, updatedAt: row.updated_at };
}

/** One change of a part, for `onChange` */
export interface PartChange {
    readonly workspaceId: string;
    readonly kind: PartKind;
    readonly id: string;
    readonly before?: object;
    readonly after?: object;
}

export interface PgPartRepositoryOptions {
    readonly now?: () => Date;
    readonly newId?: () => string;
    /**
     * Called in the transaction of every change of a part (made, written, renamed, rewritten or deleted), such as to
     * queue its embedding, with its body before (none when made) and after (none when deleted)
     */
    readonly onChange?: (tx: Queryable, change: PartChange) => Promise<void>;
    /**
     * Announces every change of a part to the other servers on the database (`PART_CHANNEL`), naming this server as
     * `source` so it can skip its own notices (`listenToPartChanges`). Nothing is announced without it
     */
    readonly announceAs?: string;
}

/**
 * One workspace's parts in `part`. A body is stored as `json`, so it reads back in the key order it was written in.
 * Revisions are checked under `SELECT ... FOR UPDATE`, so two writers of one part, in this process or another, never
 * both win; a rename writes the part and every part it rewrites in one transaction, so there is nothing to recover
 */
export class PgPartRepository implements UiPartRepository {
    private readonly now: () => Date;
    private readonly newId: () => string;
    private readonly onChange: NonNullable<PgPartRepositoryOptions['onChange']>;
    private readonly source: string | undefined;

    constructor(
        private readonly db: WorkspaceDb,
        options: PgPartRepositoryOptions = {}
    ) {
        this.now = options.now ?? (() => new Date());
        this.newId = options.newId ?? randomUUID;
        this.onChange = options.onChange ?? (async () => undefined);
        this.source = options.announceAs;
    }

    /** Tells the other servers, once the transaction commits, that a part changed */
    private async announce(tx: Queryable, kind: PartKind, name: string): Promise<void> {
        if (this.source === undefined) return;
        await tx.query('SELECT pg_notify($1, $2)', [PART_CHANNEL, partNotice(this.source, this.db.workspaceId, kind, name)]);
    }

    async create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>> {
        const problem = partInputProblem(input.kind, input.name, input.body);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        if (input.id !== undefined && !isAppId(input.id)) return { kind: 'invalid', reason: PART_ID_PROBLEM };
        try {
            return await this.db.transaction(async (tx): Promise<CreateUiPartResult<K>> => {
                if ((await this.row(tx, 'kind = $2 AND name = $3', [input.kind, input.name])) !== undefined) return { kind: 'duplicate-name' };
                if (input.id !== undefined && (await this.row(tx, 'kind = $2 AND id = $3', [input.kind, input.id.toLowerCase()])) !== undefined) return { kind: 'invalid', reason: PART_ID_TAKEN };
                const part = createUiPart({ id: input.id?.toLowerCase() ?? this.newId(), kind: input.kind, name: input.name, body: input.body, now: this.now() });
                await tx.query(`INSERT INTO part (workspace_id, ${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                    this.db.workspaceId,
                    part.id,
                    part.kind,
                    part.name,
                    part.revision,
                    JSON.stringify(part.body),
                    part.createdAt,
                    part.updatedAt
                ]);
                await this.onChange(tx, { workspaceId: this.db.workspaceId, kind: part.kind, id: part.id, after: part.body });
                await this.announce(tx, part.kind, part.name);
                return { kind: 'created', part: { ...part, body: structuredClone(part.body) } };
            });
        } catch (error) {
            // Two creates of one name or id at once: the loser sees the unique constraint
            if (isUniqueViolation(error, 'part_name')) return { kind: 'duplicate-name' };
            if (isUniqueViolation(error)) return { kind: 'invalid', reason: PART_ID_TAKEN };
            throw error;
        }
    }

    async findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined> {
        if (!isPartKind(kind)) return undefined;
        return this.db.transaction(async (tx) => {
            const row = await this.row(tx, 'kind = $2 AND name = $3', [kind, name]);
            return row === undefined ? undefined : toPart<K>(row);
        });
    }

    async findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        if (!isPartKind(kind) || !isAppId(id)) return undefined;
        return this.db.transaction(async (tx) => {
            const row = await this.row(tx, 'kind = $2 AND id = $3', [kind, id.toLowerCase()]);
            return row === undefined ? undefined : toPart<K>(row);
        });
    }

    async list(kind: PartKind): Promise<readonly UiPartSummary[]> {
        if (!isPartKind(kind)) return [];
        return this.db.transaction(async (tx) => {
            const rows = (await tx.query<Pick<PartRow, 'id' | 'name' | 'revision' | 'updated_at'>>('SELECT id, name, revision, updated_at FROM part WHERE workspace_id = $1 AND kind = $2 ORDER BY name COLLATE "C"', [this.db.workspaceId, kind])).rows;
            return rows.map((row) => ({ id: row.id, kind, name: row.name, revision: row.revision, updatedAt: row.updated_at }));
        });
    }

    async write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult> {
        if (!isPartBody(body)) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        if (!isPartKind(kind)) return { kind: 'not-found' };
        return this.db.transaction(async (tx): Promise<UiPartWriteResult> => {
            const row = await this.row(tx, 'kind = $2 AND name = $3', [kind, name], true);
            if (row === undefined) return { kind: 'not-found' };
            if (!isRevisionCurrent(row.revision, expectedRevision)) return { kind: 'conflict', currentRevision: row.revision };
            const written = reviseUiPart(toPart<K>(row), body, this.now());
            await this.save(tx, written, row.body);
            return { kind: 'written', revision: written.revision };
        });
    }

    async delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult> {
        if (!isPartKind(kind)) return { kind: 'not-found' };
        return this.db.transaction(async (tx): Promise<UiPartDeleteResult> => {
            const row = await this.row(tx, 'kind = $2 AND name = $3', [kind, name], true);
            if (row === undefined) return { kind: 'not-found' };
            if (!isRevisionCurrent(row.revision, expectedRevision)) return { kind: 'conflict', currentRevision: row.revision };
            await tx.query('DELETE FROM part WHERE workspace_id = $1 AND kind = $2 AND id = $3', [this.db.workspaceId, kind, row.id]);
            await this.onChange(tx, { workspaceId: this.db.workspaceId, kind, id: row.id, before: row.body });
            await this.announce(tx, kind, name);
            return { kind: 'deleted' };
        });
    }

    async rename(kind: PartKind, from: string, to: string, rewrites: readonly UiPartRewrite[] = []): Promise<UiPartRenameResult> {
        const problem = partNameProblem(to);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        if (!isPartKind(kind)) return { kind: 'not-found' };
        for (const rewrite of rewrites) {
            if (!isPartKind(rewrite.kind)) return { kind: 'not-found' };
            if (!isPartBody(rewrite.body)) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        }
        try {
            return await this.db.transaction(async (tx): Promise<UiPartRenameResult> => {
                // Lock every row the rename writes, in one order, so two renames never wait on each other
                const keys = [...new Map([[`${kind}/${from}`, { kind, name: from }], ...rewrites.map((rewrite) => [`${rewrite.kind}/${rewrite.name}`, { kind: rewrite.kind, name: rewrite.name }] as const)]).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
                const locked = new Map<string, PartRow>();
                for (const [key, target] of keys) {
                    const row = await this.row(tx, 'kind = $2 AND name = $3', [target.kind, target.name], true);
                    if (row !== undefined) locked.set(key, row);
                }
                const partRow = locked.get(`${kind}/${from}`);
                if (partRow === undefined) return { kind: 'not-found' };
                if ((await this.row(tx, 'kind = $2 AND name = $3', [kind, to])) !== undefined) return { kind: 'duplicate-name' };
                const part = toPart(partRow);
                const now = this.now();
                let renamedBody = part.body;
                const revised: UiPart[] = [];
                const before = new Map<string, object>([[part.id, partRow.body]]);
                for (const rewrite of rewrites) {
                    const self = rewrite.kind === kind && rewrite.name === from;
                    const currentRow = locked.get(`${rewrite.kind}/${rewrite.name}`);
                    const current = currentRow === undefined ? undefined : toPart(currentRow);
                    if (current === undefined || !isRevisionCurrent(current.revision, rewrite.expectedRevision)) {
                        return { kind: 'conflict', part: { kind: rewrite.kind, name: rewrite.name }, currentRevision: current?.revision ?? 0 };
                    }
                    if (self) renamedBody = rewrite.body as UiPartBodies[PartKind];
                    else {
                        revised.push(reviseUiPart(current, rewrite.body as UiPartBodies[PartKind], now));
                        before.set(current.id, (currentRow as PartRow).body);
                    }
                }
                const renamed = renameUiPart({ ...part, body: renamedBody }, to, now);
                for (const written of [renamed, ...revised]) await this.save(tx, written, before.get(written.id));
                await this.announce(tx, kind, from);
                const rewritten: UiPartRewritten[] = revised.map(({ kind: of, name, revision }) => ({ kind: of, name, revision }));
                return { kind: 'renamed', revision: renamed.revision, rewritten };
            });
        } catch (error) {
            if (isUniqueViolation(error, 'part_name')) return { kind: 'duplicate-name' };
            throw error;
        }
    }

    /**
     * Stores a part exactly as given, without the checks of `create`, for importing parts made elsewhere (the showcase
     * holds names from before today's rules). A part already there by kind and id, or by kind and name, is left alone
     */
    async put(part: UiPart): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.query(`INSERT INTO part (workspace_id, ${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [
                this.db.workspaceId,
                part.id.toLowerCase(),
                part.kind,
                part.name,
                part.revision,
                JSON.stringify(part.body),
                part.createdAt,
                part.updatedAt
            ]);
            await this.announce(tx, part.kind, part.name);
        });
    }

    private async row(tx: Queryable, where: string, params: readonly unknown[], forUpdate = false): Promise<PartRow | undefined> {
        return (await tx.query<PartRow>(`SELECT ${COLUMNS} FROM part WHERE workspace_id = $1 AND ${where}${forUpdate ? ' FOR UPDATE' : ''}`, [this.db.workspaceId, ...params])).rows[0];
    }

    private async save(tx: Queryable, part: UiPart, before: object | undefined): Promise<void> {
        await tx.query('UPDATE part SET name = $4, revision = $5, body = $6, updated_at = $7 WHERE workspace_id = $1 AND kind = $2 AND id = $3', [
            this.db.workspaceId,
            part.kind,
            part.id,
            part.name,
            part.revision,
            JSON.stringify(part.body),
            part.updatedAt
        ]);
        await this.onChange(tx, { workspaceId: this.db.workspaceId, kind: part.kind, id: part.id, ...(before !== undefined && { before }), after: part.body });
        await this.announce(tx, part.kind, part.name);
    }
}
