import { isAppId, MAX_PREVIEW_ERRORS } from '@punyts/stateui-mcp';
import type { UiBuildError, UiErrorLog, UiViewLoad } from '@punyts/stateui-mcp';
import type { Queryable } from '../db/Database.js';
import { appExists, lockKey } from './WorkspaceDb.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

/** One stored error with the view load it came from, when it is known */
interface LoggedError {
    readonly error: UiBuildError;
    readonly source?: UiViewLoad;
}

/**
 * The bounded runtime error log of each app (`preview_error`): the newest `MAX_PREVIEW_ERRORS`, oldest first, each with
 * the view load it came from. Changes to one app's log run under its advisory lock
 */
export class PgUiErrorLog implements UiErrorLog {
    constructor(private readonly db: WorkspaceDb) {}

    async append(appId: string, error: UiBuildError, source?: UiViewLoad): Promise<boolean> {
        if (!isAppId(appId)) return false;
        return this.db.transaction(async (tx) => {
            await lockKey(tx, this.key(appId));
            if (!(await appExists(tx, this.db.workspaceId, appId))) return false;
            const entry: LoggedError = source === undefined ? { error } : { error, source: { viewId: source.viewId, load: source.load } };
            await this.save(tx, appId, [...(await this.entries(tx, appId)), entry].slice(-MAX_PREVIEW_ERRORS));
            return true;
        });
    }

    async keepFrom(appId: string, source: UiViewLoad): Promise<boolean> {
        if (!isAppId(appId)) return false;
        return this.db.transaction(async (tx) => {
            await lockKey(tx, this.key(appId));
            if (!(await appExists(tx, this.db.workspaceId, appId))) return false;
            const entries = await this.entries(tx, appId);
            const kept = entries.filter((entry) => entry.source?.viewId === source.viewId && entry.source.load >= source.load);
            if (kept.length !== entries.length) await this.save(tx, appId, kept);
            return true;
        });
    }

    async list(appId: string): Promise<readonly UiBuildError[]> {
        if (!isAppId(appId)) return [];
        return this.db.transaction(async (tx) => (await this.entries(tx, appId)).map((entry) => entry.error));
    }

    async clear(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        await this.db.transaction(async (tx) => {
            await tx.query('DELETE FROM preview_error WHERE workspace_id = $1 AND app_id = $2', [this.db.workspaceId, appId.toLowerCase()]);
        });
    }

    private async entries(tx: Queryable, appId: string): Promise<LoggedError[]> {
        return (await tx.query<{ entries: LoggedError[] }>('SELECT entries FROM preview_error WHERE workspace_id = $1 AND app_id = $2', [this.db.workspaceId, appId.toLowerCase()])).rows[0]?.entries ?? [];
    }

    private async save(tx: Queryable, appId: string, entries: readonly LoggedError[]): Promise<void> {
        await tx.query('INSERT INTO preview_error (workspace_id, app_id, entries) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, app_id) DO UPDATE SET entries = EXCLUDED.entries', [
            this.db.workspaceId,
            appId.toLowerCase(),
            JSON.stringify(entries)
        ]);
    }

    private key(appId: string): string {
        return `errors:${this.db.workspaceId}:${appId.toLowerCase()}`;
    }
}
