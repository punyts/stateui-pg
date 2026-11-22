import { randomUUID } from 'node:crypto';
import { isAppId, NamespaceUiInstanceRepository, userStateAddress } from '@punyts/stateui-mcp';
import type { AppFolderStore, InstanceNamespaceStore, OwnerNames, ServicesStorage, UiInstanceRepository } from '@punyts/stateui-mcp';
import type { Database, Queryable } from '../db/Database.js';
import { enqueueEmbedding } from '../embeddings/EmbeddingIndex.js';
import { PART_SOURCE } from '../embeddings/partText.js';
import { queueNamespaceRecordChanges, queueRecordChanges } from '../embeddings/records.js';
import { PgEpochStorage } from '../state/PgDirectory.js';
import { PgPartRepository } from './PgPartRepository.js';
import { PgUiErrorLog } from './PgUiErrorLog.js';
import { PgUiFileRepository } from './PgUiFileRepository.js';
import { PgUiFileStore } from './PgUiFileStore.js';
import { lockKey, workspaceDb } from './WorkspaceDb.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

export interface PgWorkspaceStorageOptions {
    readonly now?: () => Date;
    readonly newId?: () => string;
    /** Queues the embedding of every part that changes, in the transaction of the change */
    readonly embedParts?: boolean;
    /** Queues the embedding of every record field a model marks `embed: true` when it changes, in datasets and persona bindings */
    readonly embedRecords?: boolean;
    /**
     * Where the instances are kept as stored namespaces (docs/design/statenet-network.md, "An instance is a stored
     * namespace"): a server gives its way to the aggregate. By default this workspace's own `pgInstanceNamespaces`,
     * which writes the rows itself
     */
    readonly namespaces?: InstanceNamespaceStore;
    /** The names owners go by in the addresses of their state (their numbers, where a statenet issues them); their ids by default */
    readonly owners?: OwnerNames;
    /** The owner epoch this server holds an instance's address under, when several servers share the database */
    readonly epochOf?: (address: string) => number | undefined;
    /** Announces every change of a part to the other servers on the database, as this server (`listenToPartChanges`) */
    readonly announceAs?: string;
}

/** What an app keeps beside its part: its files, their bytes and its preview errors; removed with the app */
class PgAppFolderStore implements AppFolderStore {
    constructor(private readonly db: WorkspaceDb) {}

    async remove(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        const app = appId.toLowerCase();
        await this.db.transaction(async (tx) => {
            await lockKey(tx, `errors:${this.db.workspaceId}:${app}`);
            await lockKey(tx, `files:${this.db.workspaceId}:${app}`);
            for (const table of ['app_file', 'app_file_content', 'preview_error']) {
                await tx.query(`DELETE FROM ${table} WHERE workspace_id = $1 AND app_id = $2`, [this.db.workspaceId, app]);
            }
        });
    }
}

/**
 * The stored namespaces of people's state in Postgres: `PgEpochStorage` (a row per top-level key and per record, the
 * epoch fence), which can remove one, and with `embedRecords` queues the embeddings of the records a save changes in
 * the save's transaction. `workspaceOf` names the workspace of an address, for row-level security. This is what an
 * aggregate writes with
 */
export function pgInstanceNamespaces(db: Database, workspaceOf: (address: string) => string | Promise<string>, options: { readonly embedRecords?: boolean } = {}): InstanceNamespaceStore {
    return new PgEpochStorage(db, workspaceOf, 1000, options.embedRecords === true ? queueNamespaceRecordChanges : undefined);
}

/**
 * One persona's instances of a workspace, read and written inside a transaction that is already open (an import, a
 * test's arrangement): each write is part of it, and nothing is queued for embedding
 */
export function txInstances(tx: Queryable, workspaceId: string, persona: string, owners?: OwnerNames): UiInstanceRepository {
    const within = { transaction: ((work: (inner: Queryable) => Promise<unknown>) => work(tx)) as Database['transaction'] };
    return new NamespaceUiInstanceRepository(new PgEpochStorage(within, () => workspaceId), (appId) => userStateAddress(workspaceId, persona, appId, owners));
}

/**
 * One workspace's storage in Postgres, for `createServices({ storage })`: its parts, the instances of each persona,
 * uploaded files and their bytes, preview errors, and what goes with an app when it is deleted. Every adapter is made
 * for this workspace and sets it on each transaction, so row-level security shows nothing of any other
 */
export function pgWorkspaceStorage(db: Database, workspaceId: string, options: PgWorkspaceStorageOptions = {}): ServicesStorage {
    const workspace = workspaceDb(db, workspaceId);
    const now = options.now ?? (() => new Date());
    const parts = new PgPartRepository(workspace, {
        now,
        newId: options.newId ?? randomUUID,
        ...(options.announceAs !== undefined && { announceAs: options.announceAs }),
        ...((options.embedParts === true || options.embedRecords === true) && {
            onChange: async (tx, change) => {
                if (options.embedParts === true) await enqueueEmbedding(tx, { workspaceId: change.workspaceId, sourceKind: PART_SOURCE, sourceId: `${change.kind}/${change.id}` });
                if (options.embedRecords === true) await queueRecordChanges(tx, change);
            }
        })
    });
    const namespaces = options.namespaces ?? pgInstanceNamespaces(db, () => workspaceId, { embedRecords: options.embedRecords === true });
    return {
        parts,
        importPart: (part) => parts.put(part),
        instances: (persona) => new NamespaceUiInstanceRepository(namespaces, (appId) => userStateAddress(workspaceId, persona, appId, options.owners), options.epochOf),
        files: new PgUiFileRepository(workspace, now),
        fileStore: new PgUiFileStore(workspace),
        errorLog: new PgUiErrorLog(workspace),
        appFolders: new PgAppFolderStore(workspace),
        // Every persona's instance of a deleted app, each namespace whole through the namespace store, at its head's epoch
        removeApp: async (appId) => {
            if (!isAppId(appId)) return;
            const heads = await db.transaction(
                async (tx) =>
                    (
                        await tx.query<{ address: string; epoch: string | number }>(
                            "SELECT address, epoch FROM namespace_head WHERE workspace_id = $1 AND address = split_part(address, '/', 1) || '/apps/' || $2 ORDER BY address",
                            [workspaceId, appId.toLowerCase()]
                        )
                    ).rows,
                { workspaceIds: [workspaceId] }
            );
            for (const head of heads) await namespaces.remove(head.address, Number(head.epoch));
        }
    };
}
