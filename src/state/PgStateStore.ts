import { FencedError } from '@punyts/state-sync/authority';
import type { Queryable } from '../db/Database.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

interface NodeRow {
    path: string;
    parent: string;
    position: number;
    kind: 'value' | 'object';
    value: Json;
}

/** A subtree read back: its value in key order, what the store keeps about its object rows by path, and the namespace's revision */
export interface StateRead {
    readonly value: JsonObject | undefined;
    readonly meta: ReadonlyMap<string, Json>;
    readonly revision: number;
}

/** Where a write goes: the namespace's address and the workspace its app is in (for row-level security) */
export interface StatePlace {
    readonly workspaceId: string;
    readonly address: string;
}

export interface StateWriteOptions {
    /** What the store keeps about the object row at the write's path, such as a person binding's model */
    readonly meta?: Json;
    /** Top-level keys a write of the whole namespace leaves as they are */
    readonly keep?: readonly string[];
    /** The id of the change that caused the write, kept in the log */
    readonly id?: string;
    /** The revision the namespace is at after the write, for a writer that numbers its own changes (an authority); the next one by default */
    readonly revision?: number;
    /** Whether to log the rows the write changed in `state_change`; true by default (an authority logs its own changes) */
    readonly log?: boolean;
    /**
     * The owner epoch the rows were written under. A write under an epoch older than the newest the namespace was
     * written under is refused with `FencedError` (its writer lost the namespace); a newer one becomes the newest
     */
    readonly epoch?: number;
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);
const under = (path: string): string => (path === '' ? '' : `${path}.`);

/**
 * Which object paths of a user's state are stored as rows of their own: `data`, and each data binding under it, so
 * each record is a row and each other top-level key is one
 */
export const splitUserState = (path: string): boolean => path === 'data' || /^data\.[^.]+$/.test(path);

/**
 * A namespace's state in `state_node`, one row per stored subtree (docs/design/statenet-relays.md, "Storage in
 * Postgres"). Which objects are split into rows is the `split` rule; everything below a value row is that row's value,
 * so a change rewrites only the rows under its path. Rows keep their position among their siblings, so a namespace
 * reads back in the key order it was written in. Every write that changes a row takes the namespace's next revision
 * (under a lock on its head), and logs each row it set or deleted in `state_change`
 */
export class PgStateStore {
    constructor(private readonly split: (path: string) => boolean = splitUserState) {}

    /** The subtree at a path ('' for the whole namespace), undefined when nothing is stored there */
    async read(tx: Queryable, address: string, at = ''): Promise<StateRead> {
        const rows = (
            await tx.query<NodeRow>(
                at === ''
                    ? 'SELECT path, parent, position, kind, value FROM state_node WHERE address = $1 ORDER BY parent, position'
                    : 'SELECT path, parent, position, kind, value FROM state_node WHERE address = $1 AND (path = $2 OR left(path, length($2) + 1) = $2 || \'.\') ORDER BY parent, position',
                at === '' ? [address] : [address, at]
            )
        ).rows;
        const revision = Number((await tx.query<{ revision: string | number }>('SELECT revision FROM namespace_head WHERE address = $1', [address])).rows[0]?.revision ?? 0);
        const children = new Map<string, NodeRow[]>();
        const meta = new Map<string, Json>();
        for (const row of rows) {
            children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
            if (row.kind === 'object' && row.value !== null) meta.set(row.path, row.value);
        }
        const build = (path: string): JsonObject => {
            const object: JsonObject = {};
            for (const row of children.get(path) ?? []) object[row.path.slice(under(path).length)] = row.kind === 'object' ? build(row.path) : row.value;
            return object;
        };
        if (at === '') return { value: rows.length === 0 ? undefined : build(''), meta, revision };
        const self = rows.find((row) => row.path === at);
        if (self === undefined) return { value: undefined, meta, revision };
        return { value: self.kind === 'object' ? build(at) : isObject(self.value) ? self.value : undefined, meta, revision };
    }

    /**
     * Stores the subtree at a path ('' for the whole namespace, leaving the top-level keys in `keep`), or removes it
     * when `value` is undefined; answers the namespace's revision, which moves only when a row changed
     */
    async write(tx: Queryable, place: StatePlace, at: string, value: JsonObject | undefined, options: StateWriteOptions = {}): Promise<number> {
        const { revision: head, epoch: headEpoch } = await this.lockHead(tx, place);
        if (options.epoch !== undefined && options.epoch < headEpoch) throw new FencedError(place.address, options.epoch, headEpoch);
        if (options.epoch !== undefined && options.epoch > headEpoch) await tx.query('UPDATE namespace_head SET epoch = $2 WHERE address = $1', [place.address, options.epoch]);
        const keep = new Set(options.keep ?? []);
        const kept = (path: string): boolean => at === '' && keep.has(path.split('.')[0] as string);
        const existing = (
            await tx.query<NodeRow>(
                at === ''
                    ? 'SELECT path, parent, position, kind, value FROM state_node WHERE address = $1'
                    : 'SELECT path, parent, position, kind, value FROM state_node WHERE address = $1 AND (path = $2 OR left(path, length($2) + 1) = $2 || \'.\')',
                at === '' ? [place.address] : [place.address, at]
            )
        ).rows.filter((row) => !kept(row.path));
        const wanted: NodeRow[] = [];
        if (value !== undefined) {
            if (at !== '') {
                const parent = at.includes('.') ? at.slice(0, at.lastIndexOf('.')) : '';
                const position = existing.find((row) => row.path === at)?.position ?? (await this.ensureParents(tx, place, parent, head));
                wanted.push(this.split(at) ? { path: at, parent, position, kind: 'object', value: options.meta ?? null } : { path: at, parent, position, kind: 'value', value });
            }
            if (at === '' || this.split(at)) this.flatten(at, value, wanted, kept);
        }
        const before = new Map(existing.map((row) => [row.path, row]));
        const after = new Map(wanted.map((row) => [row.path, row]));
        const changed = wanted.filter((row) => {
            const old = before.get(row.path);
            return old === undefined || old.kind !== row.kind || old.parent !== row.parent || old.position !== row.position || JSON.stringify(old.value) !== JSON.stringify(row.value);
        });
        const removed = existing.filter((row) => !after.has(row.path));
        if (changed.length === 0 && removed.length === 0 && options.revision === undefined) return head;
        const revision = options.revision ?? head + 1;
        const logged = options.log !== false;
        let seq = 0;
        for (const row of removed) {
            await tx.query('DELETE FROM state_node WHERE address = $1 AND path = $2', [place.address, row.path]);
            if (logged && !after.has(row.path)) await this.log(tx, place, revision, (seq += 1), options.id, row.path, 'delete', null);
        }
        for (const row of changed) {
            await tx.query(
                `INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision, epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (address, path) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, parent = EXCLUDED.parent, position = EXCLUDED.position, kind = EXCLUDED.kind, value = EXCLUDED.value, revision = EXCLUDED.revision, epoch = EXCLUDED.epoch`,
                [place.workspaceId, place.address, row.path, row.parent, row.position, row.kind, row.value === null ? null : JSON.stringify(row.value), revision, options.epoch ?? 0]
            );
            if (logged) await this.log(tx, place, revision, (seq += 1), options.id, row.path, 'set', row.value);
        }
        await tx.query('UPDATE namespace_head SET revision = $2, durable_revision = $2, updated_at = now() WHERE address = $1', [place.address, revision]);
        return revision;
    }

    /** Removes a whole namespace: its rows, its log and its head */
    async remove(tx: Queryable, address: string): Promise<void> {
        for (const table of ['state_node', 'state_change', 'namespace_head']) await tx.query(`DELETE FROM ${table} WHERE address = $1`, [address]);
    }

    private flatten(path: string, object: JsonObject, rows: NodeRow[], kept: (path: string) => boolean): void {
        Object.entries(object).forEach(([key, child], index) => {
            const at = join(path, key);
            if (kept(at)) return;
            if (this.split(at) && isObject(child)) {
                rows.push({ path: at, parent: path, position: index + 1, kind: 'object', value: null });
                this.flatten(at, child, rows, kept);
            } else rows.push({ path: at, parent: path, position: index + 1, kind: 'value', value: child });
        });
    }

    /** Makes the object rows above a path that are missing, each last among its siblings; answers the position of a new child of `parent` */
    private async ensureParents(tx: Queryable, place: StatePlace, parent: string, head: number): Promise<number> {
        if (parent !== '') {
            const exists = (await tx.query('SELECT 1 FROM state_node WHERE address = $1 AND path = $2', [place.address, parent])).rowCount ?? 0;
            if (exists === 0) {
                const grand = parent.includes('.') ? parent.slice(0, parent.lastIndexOf('.')) : '';
                const position = await this.ensureParents(tx, place, grand, head);
                await tx.query("INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision) VALUES ($1, $2, $3, $4, $5, 'object', NULL, $6)", [
                    place.workspaceId,
                    place.address,
                    parent,
                    grand,
                    position,
                    head + 1
                ]);
            }
        }
        const last = (await tx.query<{ position: number | null }>('SELECT max(position) AS position FROM state_node WHERE address = $1 AND parent = $2', [place.address, parent])).rows[0]?.position;
        return (last ?? 0) + 1;
    }

    private async lockHead(tx: Queryable, place: StatePlace): Promise<{ revision: number; epoch: number }> {
        await tx.query('INSERT INTO namespace_head (address, workspace_id) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING', [place.address, place.workspaceId]);
        const row = (await tx.query<{ revision: string | number; epoch: string | number }>('SELECT revision, epoch FROM namespace_head WHERE address = $1 FOR UPDATE', [place.address])).rows[0];
        return { revision: Number(row?.revision ?? 0), epoch: Number(row?.epoch ?? 0) };
    }

    private async log(tx: Queryable, place: StatePlace, revision: number, seq: number, id: string | undefined, path: string, op: 'set' | 'delete', value: Json): Promise<void> {
        await tx.query('INSERT INTO state_change (workspace_id, address, revision, seq, id, path, op, value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
            place.workspaceId,
            place.address,
            revision,
            seq,
            id ?? null,
            path,
            op,
            value === null ? null : JSON.stringify(value)
        ]);
    }
}
