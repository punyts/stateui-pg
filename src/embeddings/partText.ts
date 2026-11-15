import type { Queryable } from '../db/Database.js';
import type { EmbeddingSource } from './EmbeddingIndex.js';

/** The source kind of parts in the embedding index; a part's source id is `<kind>/<id>` */
export const PART_SOURCE = 'part';

/** Words that say nothing about what a part is: the shape of StateUI's JSON */
const NOISE = new Set([
    'component',
    'children',
    'on',
    'value',
    'type',
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'id',
    'name',
    'home',
    'root',
    'screens',
    'app',
    'command',
    'target',
    'from',
    'set',
    'path'
]);

/**
 * The text a part is found by: its kind and name, then the words in its body (labels, headings, field and binding names,
 * the names of the parts it uses), each once, in the order first met. Colours, sizes and other values that are not
 * words are left out
 */
export function partSearchText(kind: string, name: string, body: unknown): string {
    const seen = new Set<string>();
    const words: string[] = [];
    const add = (text: string): void => {
        const trimmed = text.trim();
        if (trimmed.length < 2 || trimmed.length > 200 || seen.has(trimmed) || NOISE.has(trimmed) || !/\p{L}{2}/u.test(trimmed) || /^(#|\$\.|\d|var\()/.test(trimmed)) return;
        seen.add(trimmed);
        words.push(trimmed);
    };
    const walk = (value: unknown, depth: number): void => {
        if (depth > 40 || words.length > 2000) return;
        if (typeof value === 'string') add(value);
        else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
        else if (typeof value === 'object' && value !== null) {
            for (const [key, child] of Object.entries(value)) {
                add(key.replace(/([a-z])([A-Z])/g, '$1 $2'));
                walk(child, depth + 1);
            }
        }
    };
    walk(body, 0);
    return `${kind.replace(/s$/, '')} ${name.replace(/-/g, ' ')}\n${words.join(' ')}`.slice(0, 8000);
}

/** Reads a part's search text for the embedding worker: source id `<kind>/<id>` */
export const partSource: EmbeddingSource = async (tx: Queryable, job) => {
    const [kind, id] = job.sourceId.split('/');
    const row = (await tx.query<{ name: string; body: unknown }>('SELECT name, body FROM part WHERE workspace_id = $1 AND kind = $2 AND id = $3', [job.workspaceId, kind, id])).rows[0];
    return row === undefined ? undefined : { text: partSearchText(kind ?? '', row.name, row.body) };
};
