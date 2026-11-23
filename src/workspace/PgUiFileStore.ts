import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isAppId } from '@punyts/stateui-mcp';
import type { ByteRange, SaveFileResult, UiFileStore } from '@punyts/stateui-mcp';
import type { WorkspaceDb } from './WorkspaceDb.js';

const HEAD_BYTES = 4096;

/**
 * The bytes of uploaded files, in `app_file_content`. A file is at most 10 MB, so it is read whole into memory, its
 * hash taken on the way, and written in one statement: a reader never sees half a file
 */
export class PgUiFileStore implements UiFileStore {
    constructor(private readonly db: WorkspaceDb) {}

    async save(appId: string, fileId: string, content: AsyncIterable<Uint8Array>, maxBytes: number): Promise<SaveFileResult> {
        if (!isAppId(appId) || !isAppId(fileId)) throw new Error('An app id and a file id are UUIDs');
        const chunks: Uint8Array[] = [];
        const hash = createHash('sha256');
        let size = 0;
        let exceeded = false;
        for await (const chunk of content) {
            if (exceeded) continue;
            if (size + chunk.length > maxBytes) {
                exceeded = true;
                chunks.length = 0;
                continue;
            }
            hash.update(chunk);
            chunks.push(chunk);
            size += chunk.length;
        }
        if (exceeded) return { kind: 'too-large' };
        const bytes = Buffer.concat(chunks);
        await this.db.transaction(async (tx) => {
            await tx.query(
                'INSERT INTO app_file_content (workspace_id, app_id, file_id, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, app_id, file_id) DO UPDATE SET bytes = EXCLUDED.bytes',
                [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase(), bytes]
            );
        });
        return { kind: 'saved', size, sha256: hash.digest('hex'), head: new Uint8Array(bytes.subarray(0, Math.min(size, HEAD_BYTES))) };
    }

    /** A range is cut in the database, so only its bytes are read */
    async open(appId: string, fileId: string, range?: ByteRange): Promise<Readable | undefined> {
        const bytes = await this.bytes(appId, fileId, range);
        return bytes === undefined ? undefined : Readable.from([bytes]);
    }

    async read(appId: string, fileId: string): Promise<Uint8Array> {
        const bytes = await this.bytes(appId, fileId);
        if (bytes === undefined) throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
        return bytes;
    }

    async remove(appId: string, fileId: string): Promise<void> {
        if (!isAppId(appId) || !isAppId(fileId)) return;
        await this.db.transaction(async (tx) => {
            await tx.query('DELETE FROM app_file_content WHERE workspace_id = $1 AND app_id = $2 AND file_id = $3', [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase()]);
        });
    }

    private async bytes(appId: string, fileId: string, range?: ByteRange): Promise<Buffer | undefined> {
        if (!isAppId(appId) || !isAppId(fileId)) return undefined;
        const ids = [this.db.workspaceId, appId.toLowerCase(), fileId.toLowerCase()];
        // `substring` of bytea counts from 1
        const [select, values] = range === undefined ? ['bytes', ids] : ['substring(bytes from $4 for $5) AS bytes', [...ids, range.start + 1, range.end - range.start + 1]];
        return this.db.transaction(
            async (tx) => (await tx.query<{ bytes: Buffer }>(`SELECT ${select} FROM app_file_content WHERE workspace_id = $1 AND app_id = $2 AND file_id = $3`, values)).rows[0]?.bytes
        );
    }
}
