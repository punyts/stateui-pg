import { randomUUID } from 'node:crypto';
import { isAppId } from '@punyts/stateui-mcp';
import type { AppFolderStore, ServicesStorage } from '@punyts/stateui-mcp';
import type { Database } from '../db/Database.js';
import { PgPartRepository } from './PgPartRepository.js';
import { PgUiErrorLog } from './PgUiErrorLog.js';
import { PgUiFileRepository } from './PgUiFileRepository.js';
import { PgUiFileStore } from './PgUiFileStore.js';
import { PgUiInstanceRepository } from './PgUiInstanceRepository.js';
import { lockKey, workspaceDb } from './WorkspaceDb.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

export interface PgWorkspaceStorageOptions {
    readonly now?: () => Date;
    readonly newId?: () => string;
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
 * One workspace's storage in Postgres, for `createServices({ storage })`: its parts, the instances of each persona,
 * uploaded files and their bytes, preview errors, and what goes with an app when it is deleted. Every adapter is made
 * for this workspace and sets it on each transaction, so row-level security shows nothing of any other
 */
export function pgWorkspaceStorage(db: Database, workspaceId: string, options: PgWorkspaceStorageOptions = {}): ServicesStorage {
    const workspace = workspaceDb(db, workspaceId);
    const now = options.now ?? (() => new Date());
    const parts = new PgPartRepository(workspace, { now, newId: options.newId ?? randomUUID });
    return {
        parts,
        importPart: (part) => parts.put(part),
        instances: (persona) => new PgUiInstanceRepository(workspace, persona),
        files: new PgUiFileRepository(workspace, now),
        fileStore: new PgUiFileStore(workspace),
        errorLog: new PgUiErrorLog(workspace),
        appFolders: new PgAppFolderStore(workspace)
    };
}
