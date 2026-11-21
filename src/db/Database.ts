import pg from 'pg';
import type { PoolConfig, QueryResultRow } from 'pg';
import { isReported, report } from '@punyts/core';

/** Anything SQL can be sent to: the database's pool, or one transaction's client */
export interface Queryable {
    query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface TransactionOptions {
    /**
     * The workspaces the transaction may see, for row-level security: set as `app.workspace_ids` for the transaction
     * only (`set_config(..., true)`). A workspace table's policy shows only its rows of these workspaces
     */
    readonly workspaceIds?: readonly string[];
}

/** The database of a server: one pool, and transactions on it */
export interface Database extends Queryable {
    readonly pool: pg.Pool;
    /** Runs `work` in one transaction, committed when it resolves and rolled back when it throws */
    transaction<T>(work: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
    /** Ends the pool. Safe to call twice */
    close(): Promise<void>;
}

export interface DatabaseOptions {
    /** A `postgres://` URL; or give `pool` */
    readonly url?: string;
    /** More settings for the pool, such as `max` or `options` (a `search_path`, for tests) */
    readonly config?: Omit<PoolConfig, 'connectionString'>;
    /** An existing pool, which `close` ends */
    readonly pool?: pg.Pool;
}

/** A UUID, the only form of id the row-level security setting takes */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep bigint (int8) columns as numbers: revisions, sizes and counts stay far below 2^53
pg.types.setTypeParser(20, (value) => Number(value));
// Keep numeric columns (dollars) as numbers
pg.types.setTypeParser(1700, (value) => Number(value));

const QUERY_CATEGORY = 'stateui-pg.query';
const TRANSACTION_CATEGORY = 'stateui-pg.transaction';
const STATEMENT = /^\s*([A-Za-z]+)/;
const TABLE = /\b(?:FROM|INTO|UPDATE|TABLE)\s+(?:ONLY\s+|IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][\w.]*)/i;

/**
 * What a report names of a statement: its kind (the first keyword, `SELECT`, `INSERT`, ...) and the first table it
 * names. Never its parameters, which are the values
 */
export function statementName(sql: string): { readonly statement: string; readonly table?: string } {
    const statement = (STATEMENT.exec(sql)?.[1] ?? 'unknown').toUpperCase();
    const table = TABLE.exec(sql)?.[1];
    return { statement, ...(table !== undefined && { table }) };
}

/** A duration in milliseconds since `start` (from `performance.now()`), rounded to a tenth */
export function msSince(start: number): number {
    return Math.round((performance.now() - start) * 10) / 10;
}

/** Runs one query and reports it under `stateui-pg.query` when that is on: the statement, the table, the rows and the duration */
async function reportedQuery<R extends QueryResultRow>(run: () => Promise<pg.QueryResult<R>>, sql: string, inTransaction: boolean): Promise<{ rows: R[]; rowCount: number | null }> {
    // Every query passes here: off, it costs one check
    if (!isReported(QUERY_CATEGORY)) {
        const result = await run();
        return { rows: result.rows, rowCount: result.rowCount };
    }
    const start = performance.now();
    try {
        const result = await run();
        report(QUERY_CATEGORY, 'Query', { ...statementName(sql), rows: result.rowCount ?? result.rows.length, ms: msSince(start), inTransaction });
        return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
        report(QUERY_CATEGORY, 'Query failed', { ...statementName(sql), code: errorCode(error), ms: msSince(start), inTransaction });
        throw error;
    }
}

/** The SQLSTATE of a Postgres error (`23505`), never its message, which may quote a value */
function errorCode(error: unknown): string {
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : 'none';
}

/** Opens the database: a pool over `url`, or the given pool */
export function createDatabase(options: DatabaseOptions): Database {
    if (options.pool === undefined && (options.url === undefined || options.url === '')) throw new Error('A database URL is needed (postgres://...)');
    const pool = options.pool ?? new pg.Pool({ connectionString: options.url, ...options.config });
    // An idle client that loses its connection must not take the process down
    pool.on('error', () => undefined);
    let closed: Promise<void> | undefined;
    return {
        pool,
        query: <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => reportedQuery(() => pool.query<R>(sql, params as unknown[]), sql, false),
        transaction: async <T>(work: (tx: Queryable) => Promise<T>, transactionOptions: TransactionOptions = {}) => {
            const client = await pool.connect();
            const start = performance.now();
            const scope = { workspaceIds: transactionOptions.workspaceIds ?? [] };
            let queries = 0;
            try {
                await client.query('BEGIN');
                if (isReported(TRANSACTION_CATEGORY)) report(TRANSACTION_CATEGORY, 'Transaction begun', scope);
                if (transactionOptions.workspaceIds !== undefined) {
                    const ids = transactionOptions.workspaceIds;
                    if (ids.some((id) => !UUID.test(id))) throw new Error('A workspace id is a UUID');
                    await client.query("SELECT set_config('app.workspace_ids', $1, true)", [ids.join(',')]);
                }
                const tx: Queryable = {
                    query: <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
                        queries++;
                        return reportedQuery(() => client.query<R>(sql, params as unknown[]), sql, true);
                    }
                };
                const result = await work(tx);
                await client.query('COMMIT');
                if (isReported(TRANSACTION_CATEGORY)) report(TRANSACTION_CATEGORY, 'Transaction committed', { ...scope, queries, ms: msSince(start) });
                return result;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                if (isReported(TRANSACTION_CATEGORY)) report(TRANSACTION_CATEGORY, 'Transaction rolled back', { ...scope, queries, code: errorCode(error), ms: msSince(start) });
                throw error;
            } finally {
                client.release();
            }
        },
        close: () => (closed ??= pool.end())
    };
}

/** True for a unique violation (23505), optionally on one constraint */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
    const pgError = error as { code?: string; constraint?: string };
    return pgError.code === '23505' && (constraint === undefined || pgError.constraint === constraint);
}
