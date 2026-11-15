import pg from 'pg';
import type { PartKind } from '@punyts/stateui-mcp';
import type { Database } from '../db/Database.js';

/** The channel parts' changes are announced on (`pg_notify`), to every server on the database */
export const PART_CHANNEL = 'stateui_part';

/** A change of a part another server made: which workspace, which part (by kind and name, the old name of a rename too) */
export interface PartNotice {
    readonly workspaceId: string;
    readonly kind: PartKind;
    readonly name: string;
}

/** The payload of a notice: short keys, well under the 8000 bytes a notification may carry */
export const partNotice = (source: string, workspaceId: string, kind: PartKind, name: string): string => JSON.stringify({ s: source, w: workspaceId, k: kind, n: name });

export interface PartChangesOptions {
    /** The wait before listening again after the connection dropped; 1 second by default */
    readonly retryMs?: number;
    /** Changes may have been missed while the connection was down: called once it is back */
    readonly onResync?: () => void;
    readonly report?: (message: string) => void;
}

export interface PartChanges {
    close(): Promise<void>;
}

/**
 * Listens for the changes of parts other servers announce (`PgPartRepositoryOptions.announceAs`), skipping this
 * server's own (`source`), on a connection of its own. A dropped connection is opened again; since notices sent
 * meanwhile are lost, `onResync` is called once it is back
 */
export async function listenToPartChanges(db: Database, source: string, listener: (notice: PartNotice) => void, options: PartChangesOptions = {}): Promise<PartChanges> {
    let client: pg.Client | undefined;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onNotification = (message: pg.Notification): void => {
        if (message.channel !== PART_CHANNEL || message.payload === undefined) return;
        try {
            const notice = JSON.parse(message.payload) as { s?: unknown; w?: unknown; k?: unknown; n?: unknown };
            if (notice.s === source || typeof notice.w !== 'string' || typeof notice.k !== 'string' || typeof notice.n !== 'string') return;
            listener({ workspaceId: notice.w, kind: notice.k as PartKind, name: notice.n });
        } catch {
            // not a notice of ours
        }
    };

    const connect = async (again: boolean): Promise<void> => {
        const made = new pg.Client(db.pool.options);
        made.on('notification', onNotification);
        made.on('error', () => dropped(made));
        made.on('end', () => dropped(made));
        await made.connect();
        await made.query(`LISTEN ${PART_CHANNEL}`);
        if (closed) {
            await made.end().catch(() => undefined);
            return;
        }
        client = made;
        if (again) options.onResync?.();
    };

    const dropped = (which: pg.Client): void => {
        if (client !== which || closed) return;
        client = undefined;
        options.report?.('The listener of part changes lost its connection; listening again');
        const retry = (): void => {
            timer = undefined;
            if (closed) return;
            connect(true).catch(() => {
                timer = setTimeout(retry, options.retryMs ?? 1000);
                (timer as { unref?: () => void }).unref?.();
            });
        };
        timer = setTimeout(retry, options.retryMs ?? 1000);
        (timer as { unref?: () => void }).unref?.();
    };

    await connect(false);
    return {
        close: async () => {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
            const current = client;
            client = undefined;
            await current?.end().catch(() => undefined);
        }
    };
}
