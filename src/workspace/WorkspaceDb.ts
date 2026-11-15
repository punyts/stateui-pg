import type { Database, Queryable } from '../db/Database.js';

/** The database as one workspace sees it: every transaction is set to that workspace for row-level security */
export interface WorkspaceDb {
    readonly workspaceId: string;
    transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function workspaceDb(db: Database, workspaceId: string): WorkspaceDb {
    const id = workspaceId.toLowerCase();
    return { workspaceId: id, transaction: (work) => db.transaction(work, { workspaceIds: [id] }) };
}

/** Holds the transaction-scoped advisory lock of a key, such as the files of one app, until the transaction ends */
export async function lockKey(tx: Queryable, key: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** True when the workspace has an app part with this id */
export async function appExists(tx: Queryable, workspaceId: string, appId: string): Promise<boolean> {
    return (await tx.query<{ found: boolean }>("SELECT EXISTS (SELECT 1 FROM part WHERE workspace_id = $1 AND kind = 'apps' AND id = $2) AS found", [workspaceId, appId.toLowerCase()])).rows[0]?.found === true;
}

/**
 * A workspace's view of a transaction that is already open, for work that spans workspaces in one transaction (moving an
 * app between them): the caller set every workspace it touches in `app.workspace_ids`
 */
export function txWorkspaceDb(tx: Queryable, workspaceId: string): WorkspaceDb {
    return { workspaceId: workspaceId.toLowerCase(), transaction: (work) => work(tx) };
}
