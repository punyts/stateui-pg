import { userStateAddress } from '@punyts/stateui-mcp';
import type { Queryable } from '../db/Database.js';
import { enqueueEmbedding } from './EmbeddingIndex.js';
import type { EmbeddingSource } from './EmbeddingIndex.js';

/** A record field of a dataset part: `<dataset part id>/<record key>`, one vector per embedded field, everyone's */
export const RECORD_SOURCE = 'record';
/** A record field of a persona binding: `<user state address>/<binding>/<record key>`, one vector per embedded field, the person's own */
export const PERSONA_RECORD_SOURCE = 'persona-record';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Records = Readonly<Record<string, Json>>;

const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields of a model body that say `embed: true` and hold strings, sorted */
export function embeddedFields(model: unknown): string[] {
    if (!isObject(model) || !isObject(model['fields'])) return [];
    return Object.entries(model['fields'])
        .filter(([, declaration]) => isObject(declaration) && declaration['embed'] === true && declaration['type'] === 'string')
        .map(([name]) => name)
        .sort();
}

/** The records of a data part body, `{}` when it has none */
const recordsOf = (body: unknown): Records => (isObject(body) && isObject(body['records']) ? body['records'] : {});
const modelOf = (body: unknown): string | undefined => (isObject(body) && typeof body['model'] === 'string' ? body['model'] : undefined);
const fieldOf = (record: Json | undefined, field: string): Json | undefined => (isObject(record) ? record[field] : undefined);

/** The `[key, field]`s whose value differs between two record maps, for the fields given: added, changed and removed records */
export function changedRecordFields(before: Records, after: Records, fields: readonly string[]): Array<readonly [string, string]> {
    const changed: Array<readonly [string, string]> = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        for (const field of fields) {
            if (JSON.stringify(fieldOf(before[key], field)) !== JSON.stringify(fieldOf(after[key], field))) changed.push([key, field]);
        }
    }
    return changed;
}

async function modelBody(tx: Queryable, workspaceId: string, name: string | undefined): Promise<unknown> {
    if (name === undefined) return undefined;
    return (await tx.query<{ body: unknown }>("SELECT body FROM part WHERE workspace_id = $1 AND kind = 'models' AND name = $2", [workspaceId, name])).rows[0]?.body;
}

/**
 * Queues the record fields a part change touches, in its transaction: a dataset's records whose embedded fields
 * changed (all of them when it moved to another model, or was made or deleted), and for a model whose embedded fields
 * changed, those fields of every record of its datasets and persona bindings. A record edit queues only that record
 * and field
 */
export async function queueRecordChanges(tx: Queryable, change: { readonly workspaceId: string; readonly kind: string; readonly id: string; readonly before?: unknown; readonly after?: unknown }): Promise<void> {
    const { workspaceId } = change;
    const queue = (sourceKind: string, sourceId: string, field: string): Promise<void> => enqueueEmbedding(tx, { workspaceId, sourceKind, sourceId, field });
    if (change.kind === 'data') {
        const [from, to] = [modelOf(change.before), modelOf(change.after)];
        if (from === to) {
            const fields = embeddedFields(await modelBody(tx, workspaceId, to));
            for (const [key, field] of changedRecordFields(recordsOf(change.before), recordsOf(change.after), fields)) await queue(RECORD_SOURCE, `${change.id}/${key}`, field);
            return;
        }
        // Another model: every field either model embeds, of every record either side holds
        const fields = [...new Set([...embeddedFields(await modelBody(tx, workspaceId, from)), ...embeddedFields(await modelBody(tx, workspaceId, to))])];
        const keys = new Set([...Object.keys(recordsOf(change.before)), ...Object.keys(recordsOf(change.after))]);
        for (const key of keys) for (const field of fields) await queue(RECORD_SOURCE, `${change.id}/${key}`, field);
        return;
    }
    if (change.kind !== 'models') return;
    const before = new Set(embeddedFields(change.before));
    const after = new Set(embeddedFields(change.after));
    const fields = [...new Set([...before, ...after])].filter((field) => before.has(field) !== after.has(field));
    if (fields.length === 0) return;
    const modelNames = (await tx.query<{ name: string }>("SELECT name FROM part WHERE workspace_id = $1 AND kind = 'models' AND id = $2", [workspaceId, change.id])).rows.map((row) => row.name);
    if (modelNames.length === 0) return;
    const datasets = (
        await tx.query<{ id: string; body: unknown }>("SELECT id, body FROM part WHERE workspace_id = $1 AND kind = 'data' AND body->>'model' = ANY($2::text[])", [workspaceId, modelNames])
    ).rows;
    for (const dataset of datasets) for (const key of Object.keys(recordsOf(dataset.body))) for (const field of fields) await queue(RECORD_SOURCE, `${dataset.id}/${key}`, field);
    // The records of every persona binding of the model, in every person's state
    const records = (
        await tx.query<{ address: string; path: string }>(
            `SELECT record.address, record.path FROM state_node binding
               JOIN state_node record ON record.address = binding.address AND record.parent = binding.path
               JOIN state_node models ON models.address = binding.address AND models.path = 'models' AND models.kind = 'value'
              WHERE binding.workspace_id = $1 AND binding.kind = 'object' AND binding.parent = 'data' AND models.value->>substr(binding.path, 6) = ANY($2::text[])`,
            [workspaceId, modelNames]
        )
    ).rows;
    for (const row of records) {
        const [, binding, key] = /^data\.([^.]+)\.(.+)$/s.exec(row.path) ?? [];
        if (binding === undefined || key === undefined) continue;
        for (const field of fields) await queue(PERSONA_RECORD_SOURCE, `${row.address}/${binding}/${key}`, field);
    }
}

/**
 * Queues the record fields that a save of a person's state changes, in its transaction (`PgEpochStorage`'s `onSave`,
 * reading `data` and `models`): for each persona binding, before or after, the fields its model embeds of the
 * records that differ
 */
export const queueNamespaceRecordChanges = {
    read: ['data', 'models'] as const,
    run: async (tx: Queryable, save: { readonly workspaceId: string; readonly address: string; readonly before: Readonly<Record<string, unknown>>; readonly after: Readonly<Record<string, unknown>> }): Promise<void> => {
        const was = { data: isObject(save.before['data']) ? save.before['data'] : {}, models: isObject(save.before['models']) ? save.before['models'] : {} };
        const now = { data: isObject(save.after['data']) ? save.after['data'] : {}, models: isObject(save.after['models']) ? save.after['models'] : {} };
        for (const binding of new Set([...Object.keys(was.data), ...Object.keys(now.data)])) {
            const before = isObject(was.data[binding]) ? was.data[binding] : {};
            const after = isObject(now.data[binding]) ? now.data[binding] : {};
            const models = [...new Set([was.models[binding], now.models[binding]].filter((model): model is string => typeof model === 'string'))];
            const fields = new Set<string>();
            for (const model of models) for (const field of embeddedFields(await modelBody(tx, save.workspaceId, model))) fields.add(field);
            // another model: every embedded field of every record either side holds, as for a dataset
            const pairs = models.length > 1 ? [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => [...fields].map((field) => [key, field] as const)) : changedRecordFields(before, after, [...fields]);
            for (const [key, field] of pairs) await enqueueEmbedding(tx, { workspaceId: save.workspaceId, sourceKind: PERSONA_RECORD_SOURCE, sourceId: `${save.address}/${binding}/${key}`, field });
        }
    }
};

/** Splits a source id into its first `count - 1` segments and the rest, which is a record key and may hold `/` */
function segments(sourceId: string, count: number): string[] | undefined {
    const parts = sourceId.split('/');
    if (parts.length < count) return undefined;
    return [...parts.slice(0, count - 1), parts.slice(count - 1).join('/')];
}

/** The text of a dataset record's field while its model still embeds the field */
export const recordSource: EmbeddingSource = async (tx, job) => {
    const [datasetId, key] = segments(job.sourceId, 2) ?? [];
    if (datasetId === undefined || key === undefined) return undefined;
    const body = (await tx.query<{ body: unknown }>("SELECT body FROM part WHERE workspace_id = $1 AND kind = 'data' AND id = $2", [job.workspaceId, datasetId])).rows[0]?.body;
    if (!embeddedFields(await modelBody(tx, job.workspaceId, modelOf(body))).includes(job.field)) return undefined;
    const value = fieldOf(recordsOf(body)[key], job.field);
    return typeof value === 'string' ? { text: value } : undefined;
};

/** The text of a persona record's field while its model still embeds the field, as the persona's own */
export const personaRecordSource: EmbeddingSource = async (tx, job) => {
    const [owner, appId, scope, binding, key] = segments(job.sourceId, 5) ?? [];
    if (owner === undefined || appId === undefined || scope !== 'user' || binding === undefined || key === undefined) return undefined;
    const address = `${owner}/${appId}/${scope}`;
    const model = (await tx.query<{ value: Record<string, unknown> | null }>("SELECT value FROM state_node WHERE address = $1 AND path = 'models' AND kind = 'value'", [address])).rows[0]?.value?.[binding];
    if (typeof model !== 'string' || !embeddedFields(await modelBody(tx, job.workspaceId, model)).includes(job.field)) return undefined;
    const record = (await tx.query<{ value: Json }>("SELECT value FROM state_node WHERE address = $1 AND path = $2 AND kind = 'value'", [address, `data.${binding}.${key}`])).rows[0]?.value;
    const value = fieldOf(record, job.field);
    return typeof value === 'string' ? { text: value, owner } : undefined;
};

/**
 * Queues every embedded field of every record, in datasets and persona bindings, of every workspace the connection
 * sees: for `reindex`, run as the database's owner, which sees past row-level security
 */
export async function queueAllRecords(db: Queryable): Promise<void> {
    const embedded = "(field.value->>'embed') = 'true' AND field.value->>'type' = 'string'";
    await db.query(
        `INSERT INTO embedding_job (workspace_id, source_kind, source_id, field)
         SELECT dataset.workspace_id, $1, dataset.id::text || '/' || record.key, field.key
           FROM part dataset
           JOIN part model ON model.workspace_id = dataset.workspace_id AND model.kind = 'models' AND model.name = dataset.body->>'model'
          CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(dataset.body->'records') = 'object' THEN dataset.body->'records' ELSE '{}'::json END) record
          CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(model.body->'fields') = 'object' THEN model.body->'fields' ELSE '{}'::json END) field
          WHERE dataset.kind = 'data' AND ${embedded}`,
        [RECORD_SOURCE]
    );
    await db.query(
        `INSERT INTO embedding_job (workspace_id, source_kind, source_id, field)
         SELECT binding.workspace_id, $1, binding.address || '/' || substr(binding.path, 6) || '/' || substr(record.path, length(binding.path) + 2), field.key
           FROM state_node binding
           JOIN state_node record ON record.address = binding.address AND record.parent = binding.path
           JOIN state_node models ON models.address = binding.address AND models.path = 'models' AND models.kind = 'value'
           JOIN part model ON model.workspace_id = binding.workspace_id AND model.kind = 'models' AND model.name = models.value->>substr(binding.path, 6)
          CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(model.body->'fields') = 'object' THEN model.body->'fields' ELSE '{}'::json END) field
          WHERE binding.kind = 'object' AND binding.parent = 'data' AND ${embedded}`,
        [PERSONA_RECORD_SOURCE]
    );
}
