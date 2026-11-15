import { diffInstance, isAppId } from '@punyts/stateui-mcp';
import type { InstanceDiff, InstanceRead, PersonaDataset, UiInstanceRepository } from '@punyts/stateui-mcp';
import type { Queryable } from '../db/Database.js';
import type { WorkspaceDb } from './WorkspaceDb.js';

/** One write of a persona binding's records, with the records it replaces, for `onData` */
export interface PersonaDataWrite {
    readonly workspaceId: string;
    readonly persona: string;
    readonly appId: string;
    readonly binding: string;
    readonly model: string;
    readonly before: unknown;
    readonly after: unknown;
}

type DiffInput = Parameters<typeof diffInstance>[0];
type JsonObject = Parameters<UiInstanceRepository['write']>[1];

/**
 * One persona's instances of a workspace's apps (`instance`) and the records of its persona bindings
 * (`persona_dataset`). An instance is stored as the diff over its definition, so a definition edit never touches it and
 * an unused app has no row. The values are `json`, so they read back in the key order they were written in
 */
export class PgUiInstanceRepository implements UiInstanceRepository {
    constructor(
        private readonly db: WorkspaceDb,
        private readonly persona: string,
        /** Called in the transaction of every write of a persona binding's records, such as to queue their embeddings */
        private readonly onData?: (tx: Queryable, write: PersonaDataWrite) => Promise<void>
    ) {}

    async get(appId: string): Promise<InstanceRead<InstanceDiff>> {
        if (!isAppId(appId)) return { value: {} };
        const row = await this.db.transaction(async (tx) => (await tx.query<{ diff: InstanceDiff }>('SELECT diff FROM instance WHERE workspace_id = $1 AND persona = $2 AND app_id = $3', [this.db.workspaceId, this.persona, appId.toLowerCase()])).rows[0]);
        return { value: row?.diff ?? {} };
    }

    async write(appId: string, definition: JsonObject, current: JsonObject): Promise<InstanceDiff> {
        const diff = diffInstance(definition as DiffInput, current as DiffInput) as InstanceDiff;
        if (!isAppId(appId)) return diff;
        await this.db.transaction(async (tx) => {
            if (Object.keys(diff).length === 0) {
                await tx.query('DELETE FROM instance WHERE workspace_id = $1 AND persona = $2 AND app_id = $3', [this.db.workspaceId, this.persona, appId.toLowerCase()]);
            } else {
                await tx.query(
                    'INSERT INTO instance (workspace_id, persona, app_id, diff, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (workspace_id, persona, app_id) DO UPDATE SET diff = EXCLUDED.diff, updated_at = now()',
                    [this.db.workspaceId, this.persona, appId.toLowerCase(), JSON.stringify(diff)]
                );
            }
        });
        return diff;
    }

    async getData(appId: string, binding: string): Promise<InstanceRead<PersonaDataset | undefined>> {
        if (!isAppId(appId)) return { value: undefined };
        const row = await this.db.transaction(
            async (tx) =>
                (await tx.query<PersonaDataset>('SELECT model, records FROM persona_dataset WHERE workspace_id = $1 AND persona = $2 AND app_id = $3 AND binding = $4', [this.db.workspaceId, this.persona, appId.toLowerCase(), binding])).rows[0]
        );
        return { value: row === undefined ? undefined : { model: row.model, records: row.records } };
    }

    async writeData(appId: string, binding: string, dataset: PersonaDataset): Promise<void> {
        if (!isAppId(appId)) throw new Error('An app id is a UUID');
        await this.db.transaction(async (tx) => {
            const before =
                this.onData === undefined
                    ? undefined
                    : (await tx.query<{ records: unknown }>('SELECT records FROM persona_dataset WHERE workspace_id = $1 AND persona = $2 AND app_id = $3 AND binding = $4 FOR UPDATE', [this.db.workspaceId, this.persona, appId.toLowerCase(), binding])).rows[0]?.records;
            await tx.query(
                `INSERT INTO persona_dataset (workspace_id, persona, app_id, binding, model, records, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
                 ON CONFLICT (workspace_id, persona, app_id, binding) DO UPDATE SET model = EXCLUDED.model, records = EXCLUDED.records, updated_at = now()`,
                [this.db.workspaceId, this.persona, appId.toLowerCase(), binding, dataset.model, JSON.stringify(dataset.records)]
            );
            await this.onData?.(tx, { workspaceId: this.db.workspaceId, persona: this.persona, appId: appId.toLowerCase(), binding, model: dataset.model, before, after: dataset.records });
        });
    }

    async reset(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        await this.db.transaction(async (tx) => {
            await tx.query('DELETE FROM instance WHERE workspace_id = $1 AND persona = $2 AND app_id = $3', [this.db.workspaceId, this.persona, appId.toLowerCase()]);
            await tx.query('DELETE FROM persona_dataset WHERE workspace_id = $1 AND persona = $2 AND app_id = $3', [this.db.workspaceId, this.persona, appId.toLowerCase()]);
        });
    }
}
