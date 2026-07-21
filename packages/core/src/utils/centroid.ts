/**
 * L2-normalized-centroid math shared by hygiene clustering
 * (`hygiene/candidate-finder.ts`) and save-time similar-memory detection
 * (`memory/memory-store.ts`). Both features define "similar" the same way —
 * centroid cosine similarity over a memory's row vectors (text chunks +
 * attachments) — so the math lives here once instead of twice.
 */

/**
 * Default centroid cosine-similarity threshold for "similar". Calibrated on a
 * real ~1.9k-memory store: 0.90 surfaces tight duplicate/superseded groups,
 * while 0.80 flags the majority of the store as candidates. Shared by memory
 * hygiene clustering and save-time similar-memory detection — one threshold,
 * one mental model for "similar" across the product. Re-exported from
 * `hygiene/candidate-finder.ts` for existing importers.
 */
export const DEFAULT_HYGIENE_THRESHOLD = 0.90;

/**
 * Mean of `vectors`, L2-normalized so cosine similarity against another
 * normalized centroid reduces to a plain dot product. Returns an all-zero
 * vector when `vectors` is empty or the mean itself has zero magnitude
 * (degenerate input) — callers should treat that as "no usable centroid".
 */
export function normalizedCentroid(vectors: number[][]): number[] {
    if (vectors.length === 0) return [];
    const dim = vectors[0].length;
    const centroid = new Array(dim).fill(0);
    for (const vector of vectors) {
        for (let d = 0; d < dim; d++) centroid[d] += vector[d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
        centroid[d] /= vectors.length;
        norm += centroid[d] * centroid[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let d = 0; d < dim; d++) centroid[d] /= norm;
    }
    return centroid;
}

/**
 * Cosine similarity between two vectors of equal dimension. When both inputs
 * are already L2-normalized (as `normalizedCentroid` returns), this is a
 * plain dot product; implemented generally here so callers with raw vectors
 * still get a correct result.
 */
export function cosine(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let d = 0; d < a.length; d++) {
        dot += a[d] * b[d];
        normA += a[d] * a[d];
        normB += b[d] * b[d];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}
