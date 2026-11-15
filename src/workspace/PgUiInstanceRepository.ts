import { diffInstance, isAppId, userStateAddress } from '@punyts/stateui-mcp';
import type { InstanceDiff, InstanceRead, PersonaDataset, UiInstanceRepository } from '@punyts/stateui-mcp';
import type { Queryable } from '../db/Database.js';
import { PgStateStore } from '../state/PgStateStore.js';
import type { JsonObject as StateObject } from '../state/PgStateStore.js';
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

const store = new PgStateStore();

/** Where a diff's own `data` is kept (an older app's data that no binding holds), as `data` holds the persona records */
const LOCAL_DATA = 'localData';

/**
 * One persona's state in a workspace's apps, each app's at its statenet address `<persona>/<appId>/user` (the
 * workspace's own id for its default persona) in `state_node`: the instance as its diff over the app's definition, a
 * row per top-level key (its own unbound `data` as `localData`), so a definition edit never touches it and an unused
 * app has no rows; and the records of its persona bindings under `data`, a row per record, each binding's model kept
 * on its row. Rows keep their key order
 */
export class PgUiInstanceRepository implements UiInstanceRepository {
    constructor(
        private readonly db: WorkspaceDb,
        private readonly persona: string,
        /** Called in the transaction of every write of a persona binding's records, such as to queue their embeddings */
        private readonly onData?: (tx: Queryable, write: PersonaDataWrite) => Promise<void>
    ) {}

    private place(appId: string): { workspaceId: string; address: string } {
        return { workspaceId: this.db.workspaceId, address: userStateAddress(this.db.workspaceId, this.persona, appId) };
    }

    async get(appId: string): Promise<InstanceRead<InstanceDiff>> {
        if (!isAppId(appId)) return { value: {} };
        const { address } = this.place(appId);
        const read = await this.db.transaction((tx) => store.read(tx, address));
        const { data: _records, [LOCAL_DATA]: local, ...diff } = read.value ?? {};
        return { value: (local === undefined ? diff : { ...diff, data: local }) as InstanceDiff };
    }

    async write(appId: string, definition: JsonObject, current: JsonObject): Promise<InstanceDiff> {
        const diff = diffInstance(definition as DiffInput, current as DiffInput) as InstanceDiff;
        if (!isAppId(appId)) return diff;
        const { data: local, ...rest } = diff as unknown as StateObject;
        const rows = local === undefined ? rest : { ...rest, [LOCAL_DATA]: local };
        await this.db.transaction((tx) => store.write(tx, this.place(appId), '', rows, { keep: ['data'] }));
        return diff;
    }

    async getData(appId: string, binding: string): Promise<InstanceRead<PersonaDataset | undefined>> {
        if (!isAppId(appId)) return { value: undefined };
        const { address } = this.place(appId);
        const read = await this.db.transaction((tx) => store.read(tx, address, `data.${binding}`));
        const model = read.meta.get(`data.${binding}`);
        if (read.value === undefined || typeof model !== 'object' || model === null || Array.isArray(model) || typeof model['model'] !== 'string') return { value: undefined };
        return { value: { model: model['model'], records: read.value as PersonaDataset['records'] } };
    }

    async writeData(appId: string, binding: string, dataset: PersonaDataset): Promise<void> {
        if (!isAppId(appId)) throw new Error('An app id is a UUID');
        const place = this.place(appId);
        await this.db.transaction(async (tx) => {
            const before = this.onData === undefined ? undefined : (await store.read(tx, place.address, `data.${binding}`)).value;
            await store.write(tx, place, `data.${binding}`, dataset.records as unknown as StateObject, { meta: { model: dataset.model } });
            await this.onData?.(tx, { workspaceId: this.db.workspaceId, persona: this.persona, appId: appId.toLowerCase(), binding, model: dataset.model, before, after: dataset.records });
        });
    }

    async reset(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        const { address } = this.place(appId);
        await this.db.transaction((tx) => store.remove(tx, address));
    }
}
