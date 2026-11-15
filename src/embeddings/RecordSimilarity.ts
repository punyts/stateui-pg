import type { UiPartRepository } from '@punyts/stateui-mcp';
import type { EmbeddingIndex } from './EmbeddingIndex.js';
import { embeddedFields, PERSONA_RECORD_SOURCE, RECORD_SOURCE } from './records.js';

/** What `similar` asks: the records of an app's binding whose field means most nearly the text */
export interface SimilarRequest {
    readonly binding: string;
    readonly field: string;
    readonly text: string;
    /** 10 by default, at most 50 */
    readonly limit?: number;
}

/** One record and how close its field is to the text: cosine similarity, 1 for the same direction */
export interface SimilarRecord {
    readonly key: string;
    readonly score: number;
}

export type SimilarAnswer = { readonly kind: 'found'; readonly results: readonly SimilarRecord[] } | { readonly kind: 'refused'; readonly reason: string };

/** Where `similar` runs: an app of a workspace, for one persona (whose own records a persona binding searches) */
export interface SimilarPlace {
    readonly workspaceId: string;
    readonly parts: Pick<UiPartRepository, 'findById' | 'findByName'>;
    readonly appId: string;
    readonly persona: string;
}

const MAX_LIMIT = 50;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `similar` data operation (docs/design/magnetic-postgres.md, "Four kinds of semantic search"): the keys of the
 * records of an app's binding whose `embed: true` field is closest in meaning to a text, best first. A dataset binding
 * searches the dataset's records; a persona binding only the persona's own. The answer is keys with scores, so the
 * app reads the records as usual. A record written moments ago is found once the worker has embedded it
 */
export class RecordSimilarity {
    constructor(private readonly index: EmbeddingIndex) {}

    async similar(place: SimilarPlace, request: SimilarRequest): Promise<SimilarAnswer> {
        if (typeof request.text !== 'string' || request.text.trim() === '') return { kind: 'refused', reason: 'similar needs a text to compare with' };
        const app = await place.parts.findById('apps', place.appId);
        if (app === undefined) return { kind: 'refused', reason: 'the app is not there' };
        const uses = (app.body as { uses?: { data?: Record<string, unknown> } }).uses;
        const binding = uses?.data?.[request.binding];
        if (!isObject(binding)) return { kind: 'refused', reason: `the app has no data binding "${request.binding}"` };
        const limit = Math.min(Math.max(Math.trunc(request.limit ?? 10), 1), MAX_LIMIT);
        if (typeof binding['dataset'] === 'string') {
            const dataset = await place.parts.findByName('data', binding['dataset']);
            if (dataset === undefined) return { kind: 'refused', reason: `the dataset "${binding['dataset']}" is not there` };
            const refusal = await this.refusal(place, (dataset.body as { model?: string }).model, request.field);
            if (refusal !== undefined) return { kind: 'refused', reason: refusal };
            return this.search(place.workspaceId, RECORD_SOURCE, `${dataset.id}/`, request, limit);
        }
        if (binding['scope'] === 'persona' && typeof binding['model'] === 'string') {
            const refusal = await this.refusal(place, binding['model'], request.field);
            if (refusal !== undefined) return { kind: 'refused', reason: refusal };
            // As the persona's records are stored: under the persona exactly as the instance names it
            const persona = place.persona;
            return this.search(place.workspaceId, PERSONA_RECORD_SOURCE, `${place.appId.toLowerCase()}/${request.binding}/${persona}/`, request, limit, persona);
        }
        return { kind: 'refused', reason: `the data binding "${request.binding}" is neither a dataset nor a persona binding` };
    }

    /** Why the field cannot be searched: no such model, or the model does not embed it */
    private async refusal(place: SimilarPlace, model: string | undefined, field: string): Promise<string | undefined> {
        const found = model === undefined ? undefined : await place.parts.findByName('models', model);
        if (found === undefined) return `the model "${model ?? ''}" is not there`;
        if (!embeddedFields(found.body).includes(field)) return `the field "${field}" of the model "${model}" is not a string field with embed: true`;
        return undefined;
    }

    private async search(workspaceId: string, sourceKind: string, prefix: string, request: SimilarRequest, limit: number, owner?: string): Promise<SimilarAnswer> {
        const hits = await this.index.search({ workspaceIds: [workspaceId], sourceKind, query: request.text, limit, sourcePrefix: prefix, field: request.field, ...(owner !== undefined && { owner }) });
        return { kind: 'found', results: hits.map((hit) => ({ key: hit.sourceId.slice(prefix.length), score: Math.round(hit.score * 1000) / 1000 })) };
    }
}
