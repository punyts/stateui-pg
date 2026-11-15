import type { Queryable } from '../db/Database.js';
import { enqueueEmbedding } from './EmbeddingIndex.js';
import type { EmbeddingSource } from './EmbeddingIndex.js';

/** A record field of a dataset part: `<dataset part id>/<record key>`, one vector per embedded field, everyone's */
export const RECORD_SOURCE = 'record';
/** A record field of a persona binding: `<app id>/<binding>/<persona>/<record key>`, one vector per embedded field, the persona's own */
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
    const bindings = (
        await tx.query<{ persona: string; app_id: string; binding: string; records: Records }>('SELECT persona, app_id, binding, records FROM persona_dataset WHERE workspace_id = $1 AND model = ANY($2::text[])', [
            workspaceId,
            modelNames
        ])
    ).rows;
    for (const row of bindings) {
        for (const key of Object.keys(isObject(row.records) ? row.records : {})) {
            for (const field of fields) await queue(PERSONA_RECORD_SOURCE, `${row.app_id}/${row.binding}/${row.persona}/${key}`, field);
        }
    }
}

/** Queues the record fields of one persona binding that a write changes, in its transaction */
export async function queuePersonaRecordChanges(
    tx: Queryable,
    write: { readonly workspaceId: string; readonly persona: string; readonly appId: string; readonly binding: string; readonly model: string; readonly before: unknown; readonly after: unknown }
): Promise<void> {
    const fields = embeddedFields(await modelBody(tx, write.workspaceId, write.model));
    const before = isObject(write.before) ? write.before : {};
    const after = isObject(write.after) ? write.after : {};
    for (const [key, field] of changedRecordFields(before, after, fields)) {
        await enqueueEmbedding(tx, { workspaceId: write.workspaceId, sourceKind: PERSONA_RECORD_SOURCE, sourceId: `${write.appId}/${write.binding}/${write.persona}/${key}`, field });
    }
}

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
    const [appId, binding, persona, key] = segments(job.sourceId, 4) ?? [];
    if (appId === undefined || binding === undefined || persona === undefined || key === undefined) return undefined;
    const row = (
        await tx.query<{ model: string; records: Records }>('SELECT model, records FROM persona_dataset WHERE workspace_id = $1 AND persona = $2 AND app_id = $3 AND binding = $4', [job.workspaceId, persona, appId, binding])
    ).rows[0];
    if (row === undefined || !embeddedFields(await modelBody(tx, job.workspaceId, row.model)).includes(job.field)) return undefined;
    const value = fieldOf(isObject(row.records) ? row.records[key] : undefined, job.field);
    return typeof value === 'string' ? { text: value, owner: persona } : undefined;
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
         SELECT binding.workspace_id, $1, binding.app_id::text || '/' || binding.binding || '/' || binding.persona || '/' || record.key, field.key
           FROM persona_dataset binding
           JOIN part model ON model.workspace_id = binding.workspace_id AND model.kind = 'models' AND model.name = binding.model
          CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(binding.records) = 'object' THEN binding.records ELSE '{}'::json END) record
          CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(model.body->'fields') = 'object' THEN model.body->'fields' ELSE '{}'::json END) field
          WHERE ${embedded}`,
        [PERSONA_RECORD_SOURCE]
    );
}
