import { isAppId, MAX_BYTES_PER_APP, MAX_FILES_PER_APP } from '@punyts/stateui-mcp';
import type { AddUiFileInput, AddUiFileResult, ReleaseUiFileOutcome, UiFile, UiFileRepository, UiFileUsage } from '@punyts/stateui-mcp';
import type { Queryable } from '../db/Database.js';
import { appExists, lockKey } from './WorkspaceDb.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

interface FileRow {
    id: string;
    app_id: string;
    name: string;
    size: number;
    type: string;
    sha256: string;
    created_at: Date;
}

const COLUMNS = 'id, app_id, name, size, type, sha256, created_at';

function toFile(row: FileRow): UiFile {
    return { id: row.id, appId: row.app_id, name: row.name, size: row.size, type: row.type, sha256: row.sha256, createdAt: row.created_at };
}

/**
 * The metadata of the files of a workspace's apps (`app_file`). Adding checks the app and both quotas under the
 * transaction's advisory lock of the app's files, which holds across processes, and so do the removals
 */
export class PgUiFileRepository implements UiFileRepository {
    constructor(
        private readonly db: WorkspaceDb,
        private readonly now: () => Date = () => new Date()
    ) {}

    appExists(appId: string): Promise<boolean> {
        if (!isAppId(appId)) return Promise.resolve(false);
        return this.db.transaction((tx) => appExists(tx, this.db.workspaceId, appId));
    }

    async usage(appId: string): Promise<UiFileUsage> {
        if (!isAppId(appId)) return { count: 0, bytes: 0 };
        return this.db.transaction((tx) => this.usageIn(tx, appId));
    }

    async add(input: AddUiFileInput): Promise<AddUiFileResult> {
        if (!isAppId(input.appId) || !isAppId(input.id)) return { kind: 'not-found' };
        return this.db.transaction(async (tx): Promise<AddUiFileResult> => {
            await lockKey(tx, this.key(input.appId));
            if (!(await appExists(tx, this.db.workspaceId, input.appId))) return { kind: 'not-found' };
            const usage = await this.usageIn(tx, input.appId);
            if (usage.count >= MAX_FILES_PER_APP) return { kind: 'quota', reason: 'files' };
            if (usage.bytes + input.size > MAX_BYTES_PER_APP) return { kind: 'quota', reason: 'bytes' };
            const row = (
                await tx.query<FileRow>(`INSERT INTO app_file (workspace_id, ${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`, [
                    this.db.workspaceId,
                    input.id.toLowerCase(),
                    input.appId.toLowerCase(),
                    input.name,
                    input.size,
                    input.type,
                    input.sha256,
                    this.now()
                ])
            ).rows[0] as FileRow;
            return { kind: 'added', file: toFile(row) };
        });
    }

    async findById(appId: string, fileId: string): Promise<UiFile | undefined> {
        if (!isAppId(appId) || !isAppId(fileId)) return undefined;
        return this.db.transaction(async (tx) => {
            const row = (await tx.query<FileRow>(`SELECT ${COLUMNS} FROM app_file WHERE workspace_id = $1 AND app_id = $2 AND id = $3`, [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase()])).rows[0];
            return row === undefined ? undefined : toFile(row);
        });
    }

    async list(appId: string): Promise<readonly UiFile[]> {
        if (!isAppId(appId)) return [];
        return this.db.transaction(async (tx) => (await tx.query<FileRow>(`SELECT ${COLUMNS} FROM app_file WHERE workspace_id = $1 AND app_id = $2 ORDER BY created_at DESC, id`, [this.db.workspaceId, appId.toLowerCase()])).rows.map(toFile));
    }

    async findOlderThan(appId: string, olderThan: Date): Promise<readonly UiFile[]> {
        if (!isAppId(appId)) return [];
        return this.db.transaction(
            async (tx) => (await tx.query<FileRow>(`SELECT ${COLUMNS} FROM app_file WHERE workspace_id = $1 AND app_id = $2 AND created_at < $3 ORDER BY created_at, id`, [this.db.workspaceId, appId.toLowerCase(), olderThan])).rows.map(toFile)
        );
    }

    async deleteByIds(appId: string, fileIds: readonly string[]): Promise<void> {
        if (!isAppId(appId)) return;
        const ids = fileIds.filter(isAppId).map((id) => id.toLowerCase());
        if (ids.length === 0) return;
        await this.db.transaction(async (tx) => {
            await lockKey(tx, this.key(appId));
            await tx.query('DELETE FROM app_file WHERE workspace_id = $1 AND app_id = $2 AND id = ANY($3::uuid[])', [this.db.workspaceId, appId.toLowerCase(), ids]);
        });
    }

    async deleteUnlessReferenced(appId: string, fileId: string, isReferenced: () => Promise<boolean>): Promise<ReleaseUiFileOutcome> {
        if (!isAppId(appId) || !isAppId(fileId)) return 'not-found';
        return this.db.transaction(async (tx): Promise<ReleaseUiFileOutcome> => {
            await lockKey(tx, this.key(appId));
            const found = (await tx.query('SELECT 1 FROM app_file WHERE workspace_id = $1 AND app_id = $2 AND id = $3', [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase()])).rows.length > 0;
            if (!found) return 'not-found';
            if (await isReferenced()) return 'referenced';
            await tx.query('DELETE FROM app_file WHERE workspace_id = $1 AND app_id = $2 AND id = $3', [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase()]);
            return 'deleted';
        });
    }

    private async usageIn(tx: Queryable, appId: string): Promise<UiFileUsage> {
        const row = (await tx.query<{ count: number; bytes: number | null }>('SELECT count(*)::int AS count, sum(size)::bigint AS bytes FROM app_file WHERE workspace_id = $1 AND app_id = $2', [this.db.workspaceId, appId.toLowerCase()])).rows[0];
        return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
    }

    private key(appId: string): string {
        return `files:${this.db.workspaceId}:${appId.toLowerCase()}`;
    }
}
