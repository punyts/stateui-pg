import pg from 'pg';
import type { PoolConfig, QueryResultRow } from 'pg';

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

/** Opens the database: a pool over `url`, or the given pool */
export function createDatabase(options: DatabaseOptions): Database {
    if (options.pool === undefined && (options.url === undefined || options.url === '')) throw new Error('A database URL is needed (postgres://...)');
    const pool = options.pool ?? new pg.Pool({ connectionString: options.url, ...options.config });
    // An idle client that loses its connection must not take the process down
    pool.on('error', () => undefined);
    let closed: Promise<void> | undefined;
    return {
        pool,
        query: async <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
            const result = await pool.query<R>(sql, params as unknown[]);
            return { rows: result.rows, rowCount: result.rowCount };
        },
        transaction: async <T>(work: (tx: Queryable) => Promise<T>, transactionOptions: TransactionOptions = {}) => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                if (transactionOptions.workspaceIds !== undefined) {
                    const ids = transactionOptions.workspaceIds;
                    if (ids.some((id) => !UUID.test(id))) throw new Error('A workspace id is a UUID');
                    await client.query("SELECT set_config('app.workspace_ids', $1, true)", [ids.join(',')]);
                }
                const tx: Queryable = {
                    query: async <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
                        const result = await client.query<R>(sql, params as unknown[]);
                        return { rows: result.rows, rowCount: result.rowCount };
                    }
                };
                const result = await work(tx);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
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
