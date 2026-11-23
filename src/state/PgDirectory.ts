import { FencedError } from '@punyts/state-sync/authority';
import type { RevisedChange } from '@punyts/state-sync';
import type { EpochStorage, OwnershipRecord, OwnershipStore, StoredNamespace } from '@punyts/state-sync/authority';
import type { Database, Queryable } from '../db/Database.js';
import { PgStateStore } from './PgStateStore.js';
import type { JsonObject } from './PgStateStore.js';

/**
 * Ownership in `namespace_owner` (docs/design/statenet-relays.md, "One writer at a time"): every change of owner is
 * one compare-and-swap statement that raises the epoch, taken when nobody owns the namespace, when the owner's lease
 * ran out (by the database's clock), or when the claimant names the current epoch (a handoff)
 */
export class PgOwnershipStore implements OwnershipStore {
    constructor(private readonly db: Database) {}

    async get(address: string): Promise<OwnershipRecord | undefined> {
        const row = (await this.db.query<{ address: string; node: string; epoch: string | number; lease_until: Date }>('SELECT address, node, epoch, lease_until FROM namespace_owner WHERE address = $1', [address])).rows[0];
        return row === undefined ? undefined : { address: row.address, node: row.node, epoch: Number(row.epoch), leaseUntil: row.lease_until.getTime() };
    }

    async take(address: string, node: string, leaseMs: number, fromEpoch?: number): Promise<OwnershipRecord | undefined> {
        const row = (
            await this.db.query<{ address: string; node: string; epoch: string | number; lease_until: Date }>(
                `INSERT INTO namespace_owner (address, node, epoch, lease_until) VALUES ($1, $2, 1, now() + make_interval(secs => $3::double precision / 1000))
                 ON CONFLICT (address) DO UPDATE SET node = EXCLUDED.node, epoch = namespace_owner.epoch + 1, lease_until = EXCLUDED.lease_until
                  WHERE namespace_owner.lease_until <= now() OR namespace_owner.epoch = $4
                 RETURNING address, node, epoch, lease_until`,
                [address, node, leaseMs, fromEpoch ?? -1]
            )
        ).rows[0];
        return row === undefined ? undefined : { address: row.address, node: row.node, epoch: Number(row.epoch), leaseUntil: row.lease_until.getTime() };
    }

    async renew(address: string, node: string, epoch: number, leaseMs: number): Promise<boolean> {
        const renewed = await this.db.query('UPDATE namespace_owner SET lease_until = now() + make_interval(secs => $4::double precision / 1000) WHERE address = $1 AND node = $2 AND epoch = $3', [address, node, epoch, leaseMs]);
        return (renewed.rowCount ?? 0) === 1;
    }
}

/** One save of a namespace, as `PgEpochStorage`'s `onSave` sees it */
export interface NamespaceSave {
    readonly workspaceId: string;
    readonly address: string;
    /** What is stored now under each key asked for; undefined for a key that holds no object */
    readonly before: Readonly<Record<string, JsonObject | undefined>>;
    readonly after: JsonObject;
}

/** A node of the statenet as the directory lists it */
export interface DirectoryNode {
    readonly id: string;
    readonly role: 'owner' | 'relay' | 'aggregate';
    readonly region?: string;
    readonly endpoint?: string;
    readonly publicKey?: string;
    readonly parent?: string;
    /** The nodes that run together (docs/design/statenet-network.md, "Groups"); '' or none for a node with none */
    readonly group?: string;
    readonly capacity?: number;
    readonly protocol?: number;
}

/**
 * The nodes of the statenet in `statenet_node` (docs/design/statenet-relays.md, "The directory"): a node registers
 * when it starts and heartbeats every few seconds; `sweep` takes out the ones that missed their heartbeats. Their
 * namespaces are taken over by others once the leases run out
 */
export class PgDirectory {
    constructor(private readonly db: Database) {}

    async register(node: DirectoryNode): Promise<void> {
        await this.db.query(
            `INSERT INTO statenet_node (id, role, region, endpoint, public_key, parent, capacity, protocol, group_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, region = EXCLUDED.region, endpoint = EXCLUDED.endpoint, public_key = EXCLUDED.public_key, parent = EXCLUDED.parent,
                 capacity = EXCLUDED.capacity, protocol = EXCLUDED.protocol, group_name = EXCLUDED.group_name, started_at = now(), heartbeat_at = now()`,
            [node.id, node.role, node.region ?? '', node.endpoint ?? '', node.publicKey ?? '', node.parent ?? null, node.capacity ?? 0, node.protocol ?? 1, node.group ?? '']
        );
    }

    /** False when the node is no longer in the directory (it was swept out): it must register again */
    async heartbeat(nodeId: string): Promise<boolean> {
        return ((await this.db.query('UPDATE statenet_node SET heartbeat_at = now() WHERE id = $1', [nodeId])).rowCount ?? 0) === 1;
    }

    /** Takes a node out of the directory at once (a relay whose link to the aggregate closed) */
    async remove(nodeId: string): Promise<void> {
        await this.db.query('DELETE FROM statenet_node WHERE id = $1', [nodeId]);
    }

    /** Takes out the nodes whose last heartbeat is older than `staleMs`; answers their ids */
    async sweep(staleMs: number): Promise<string[]> {
        return (await this.db.query<{ id: string }>('DELETE FROM statenet_node WHERE heartbeat_at < now() - make_interval(secs => $1::double precision / 1000) RETURNING id', [staleMs])).rows.map((row) => row.id);
    }

    async nodes(): Promise<DirectoryNode[]> {
        const rows = (await this.db.query<{ id: string; role: DirectoryNode['role']; region: string; endpoint: string; public_key: string; parent: string | null; capacity: number; protocol: number; group_name: string }>('SELECT id, role, region, endpoint, public_key, parent, capacity, protocol, group_name FROM statenet_node ORDER BY id')).rows;
        return rows.map((row) => ({ id: row.id, role: row.role, region: row.region, endpoint: row.endpoint, publicKey: row.public_key, ...(row.parent !== null && { parent: row.parent }), capacity: row.capacity, protocol: row.protocol, ...(row.group_name !== '' && { group: row.group_name }) }));
    }
}

/**
 * A namespace an owner node holds, in `state_node`, `state_change` and `namespace_head`, refusing saves from an older
 * epoch (docs/design/statenet-relays.md, "Epochs fence old owners"): its state row by row, the authority's log in
 * `state_change`, and its revision, epoch and applied change ids on its head. A save at or below the head's revision
 * under the head's epoch writes nothing. `workspaceOf` names the workspace a namespace's rows belong to, for row-level
 * security
 */
export class PgEpochStorage implements EpochStorage {
    private readonly store = new PgStateStore();

    constructor(
        /** The database, or anything that runs work in a transaction (one already open, for a write that is part of it) */
        private readonly db: Pick<Database, 'transaction'>,
        /** May read it (the aggregate finds it in the database at each call) */
        private readonly workspaceOf: (address: string) => string | Promise<string>,
        private readonly logLength = 1000,
        /**
         * Called in the transaction of every save, before the rows change, with what is stored under `read` (top-level
         * keys) and the state about to be: for what must be queued with the save, such as the embeddings of records
         */
        private readonly onSave?: { readonly read: readonly string[]; readonly run: (tx: Queryable, save: NamespaceSave) => Promise<void> }
    ) {}

    /** Removes a namespace whole: its rows, its log and its head. With `epoch`, refused under one older than its newest */
    async remove(address: string, epoch?: number): Promise<void> {
        await this.db.transaction(
            async (tx) => {
                const current = Number((await tx.query<{ epoch: string | number }>('SELECT epoch FROM namespace_head WHERE address = $1 FOR UPDATE', [address])).rows[0]?.epoch ?? 0);
                if (epoch !== undefined && epoch < current) throw new FencedError(address, epoch, current);
                await this.store.remove(tx, address);
            },
            { workspaceIds: [await this.workspaceOf(address)] }
        );
    }

    async load(address: string): Promise<StoredNamespace | undefined> {
        const workspaceId = await this.workspaceOf(address);
        return this.db.transaction(
            async (tx) => {
                const head = (await tx.query<{ revision: string | number; applied: StoredNamespace['applied'] }>('SELECT revision, applied FROM namespace_head WHERE address = $1', [address])).rows[0];
                if (head === undefined) return undefined;
                const read = await this.store.read(tx, address);
                const log = (
                    await tx.query<{ revision: string | number; id: string; path: string; op: RevisedChange['op']; value: RevisedChange['value'] | null }>(
                        'SELECT revision, id, path, op, value FROM state_change WHERE address = $1 AND seq = 0 ORDER BY revision DESC LIMIT $2',
                        [address, this.logLength]
                    )
                ).rows
                    .reverse()
                    .map((row) => ({ id: row.id, path: row.path, op: row.op, base: 0, revision: Number(row.revision), ...(row.op === 'delete' ? {} : { value: row.value as RevisedChange['value'] }) }) as RevisedChange);
                return { state: (read.value ?? {}) as StoredNamespace['state'], revision: Number(head.revision), log, applied: head.applied };
            },
            { workspaceIds: [workspaceId] }
        );
    }

    async save(address: string, stored: StoredNamespace, epoch: number): Promise<void> {
        const workspaceId = await this.workspaceOf(address);
        await this.db.transaction(
            async (tx) => {
                await tx.query('INSERT INTO namespace_head (address, workspace_id) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING', [address, workspaceId]);
                const head = (await tx.query<{ revision: string | number; epoch: string | number }>('SELECT revision, epoch FROM namespace_head WHERE address = $1 FOR UPDATE', [address])).rows[0];
                const current = Number(head?.epoch ?? 0);
                if (epoch < current) throw new FencedError(address, epoch, current);
                const from = Number(head?.revision ?? 0);
                // a save sent again (after an aggregate restarted, or over another relay) is what landed: nothing to write
                if (epoch === current && from > 0 && stored.revision <= from) return;
                if (this.onSave !== undefined) {
                    const before: Record<string, JsonObject | undefined> = {};
                    for (const key of this.onSave.read) before[key] = (await this.store.read(tx, address, key)).value;
                    await this.onSave.run(tx, { workspaceId, address, before, after: stored.state as JsonObject });
                }
                await this.store.write(tx, { workspaceId, address }, '', stored.state as JsonObject, { revision: stored.revision, log: false, epoch });
                // the authority's own changes are the log, for catch-up and audit (seq 0; the store's row log uses 1 and up)
                for (const change of stored.log.filter((logged) => logged.revision > from)) {
                    await tx.query('INSERT INTO state_change (workspace_id, address, revision, seq, epoch, id, path, op, value) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING', [
                        workspaceId,
                        address,
                        change.revision,
                        epoch,
                        change.id,
                        change.path,
                        change.op,
                        change.value === undefined ? null : JSON.stringify(change.value)
                    ]);
                }
                await tx.query('UPDATE namespace_head SET revision = $2, durable_revision = $2, epoch = $3, applied = $4, updated_at = now() WHERE address = $1', [address, stored.revision, epoch, JSON.stringify(stored.applied)]);
            },
            { workspaceIds: [workspaceId] }
        );
    }
}
