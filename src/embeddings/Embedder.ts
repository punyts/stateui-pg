import { createHash } from 'node:crypto';

/** What a text is embedded for: a stored document, or a search query (some models embed the two differently) */
export type EmbedPurpose = 'document' | 'query';

/**
 * Makes vectors of texts with one model. Every vector it makes is stored under `model`, and a search compares only
 * vectors of the same model, so an embedder never falls back to another
 */
export interface Embedder {
    /** The model's id, stored with every vector */
    readonly model: string;
    readonly dimensions: number;
    embed(texts: readonly string[], purpose: EmbedPurpose): Promise<number[][]>;
}

function normalize(vector: number[]): number[] {
    const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return length === 0 ? vector : vector.map((value) => value / length);
}

/** The words of a text, lower case, for the hash embedder */
function wordsOf(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 1);
}

/**
 * Vectors from hashing words and their three-letter pieces into buckets: no model, no download, the same everywhere.
 * Texts that share words come out close, which is enough for tests and for a server with no model; it does not know
 * that two different words mean the same. Its model id says so (`hash-<dimensions>`)
 */
export function hashEmbedder(dimensions = 256): Embedder {
    return {
        model: `hash-${dimensions}`,
        dimensions,
        embed: async (texts) =>
            texts.map((text) => {
                const vector = new Array<number>(dimensions).fill(0);
                for (const word of wordsOf(text)) {
                    const pieces = [word, ...Array.from({ length: Math.max(0, word.length - 2) }, (_, index) => `#${word.slice(index, index + 3)}`)];
                    for (const piece of pieces) {
                        const digest = createHash('sha256').update(piece).digest();
                        const bucket = digest.readUInt32BE(0) % dimensions;
                        vector[bucket] = (vector[bucket] ?? 0) + (piece === word ? 2 : 1) * (digest[4] !== undefined && digest[4] % 2 === 0 ? 1 : -1);
                    }
                }
                return normalize(vector);
            })
    };
}

/** The local CPU model Magnetic uses: all-MiniLM-L6-v2 in ONNX, 384 dimensions, no key */
export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

interface FeatureExtractor {
    (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

/**
 * The local model on the CPU (ONNX Runtime through `@huggingface/transformers`, an optional dependency): 384
 * dimensions, mean pooled and normalized. The model is loaded once, on first use, from `cacheDir` (bake it into the
 * server's image so a server starts without network), and texts are embedded in the order given
 */
export function localEmbedder(options: { readonly model?: string; readonly cacheDir?: string; readonly localOnly?: boolean } = {}): Embedder {
    const model = options.model ?? LOCAL_MODEL;
    let extractor: Promise<FeatureExtractor> | undefined;
    const load = async (): Promise<FeatureExtractor> => {
        const name = '@huggingface/transformers';
        const transformers = (await import(name).catch(() => {
            throw new Error('The local embedding model needs @huggingface/transformers: npm install @huggingface/transformers');
        })) as { pipeline: (task: string, model: string, options?: object) => Promise<FeatureExtractor>; env: { cacheDir?: string; allowRemoteModels?: boolean } };
        if (options.cacheDir !== undefined) transformers.env.cacheDir = options.cacheDir;
        if (options.localOnly === true) transformers.env.allowRemoteModels = false;
        return transformers.pipeline('feature-extraction', model, { dtype: 'fp32' });
    };
    return {
        model,
        dimensions: 384,
        embed: async (texts) => {
            if (texts.length === 0) return [];
            extractor ??= load().catch((error: unknown) => {
                extractor = undefined;
                throw error;
            });
            const output = await (await extractor)([...texts], { pooling: 'mean', normalize: true });
            return output.tolist();
        }
    };
}
