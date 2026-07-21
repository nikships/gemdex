import * as crypto from 'node:crypto';
import type { ParentVectorData } from '../memory/memory-store';
import { DEFAULT_HYGIENE_THRESHOLD, normalizedCentroid } from '../utils/centroid';
import { HygieneCluster, HygieneClusterMember } from './types';

// Re-exported for existing importers — the threshold now lives in
// `utils/centroid.ts` so save-time similar-memory detection can share it
// without a memory <-> hygiene module cycle.
export { DEFAULT_HYGIENE_THRESHOLD };

/** Largest cluster the judge is asked to reason about at once. */
export const MAX_CLUSTER_MEMBERS = 8;

/** sha256 hex of the sorted member ids joined with '\n' — stable under member order. */
export function clusterIdFor(memberIds: string[]): string {
    const sorted = [...memberIds].sort();
    return crypto.createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

/** Union-find with path compression and component-size tracking. */
class DisjointSet {
    private readonly parent: Int32Array;
    private readonly size: Int32Array;

    constructor(count: number) {
        this.parent = new Int32Array(count);
        this.size = new Int32Array(count).fill(1);
        for (let i = 0; i < count; i++) this.parent[i] = i;
    }

    find(x: number): number {
        let root = x;
        while (this.parent[root] !== root) root = this.parent[root];
        while (this.parent[x] !== root) {
            const next = this.parent[x];
            this.parent[x] = root;
            x = next;
        }
        return root;
    }

    sizeOf(x: number): number {
        return this.size[this.find(x)];
    }

    union(a: number, b: number): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return;
        this.parent[rb] = ra;
        this.size[ra] += this.size[rb];
    }
}

/**
 * Find candidate clusters of similar memories using only the vectors already
 * stored in LanceDB — zero API calls. Each parent's centroid is the
 * L2-normalized mean of its row vectors; pairs whose centroid cosine
 * similarity reaches `threshold` are merged by size-capped greedy
 * agglomeration: pairs are processed strongest-first, and a merge is applied
 * only if the combined component stays within {@link MAX_CLUSTER_MEMBERS}.
 * Clusters = components with >= 2 members, sorted by similarity desc, members
 * newest-first by updatedAt.
 */
export function findCandidateClusters(
    parents: ParentVectorData[],
    threshold: number,
): HygieneCluster[] {
    const usable = parents.filter((p) => p.vectors.length > 0 && p.vectors[0].length > 0);
    const n = usable.length;
    if (n < 2) return [];
    const dim = usable[0].vectors[0].length;

    // One contiguous Float64Array of all L2-normalized centroids keeps the
    // O(n^2) similarity loop allocation-free. Each parent's centroid itself
    // comes from the shared `normalizedCentroid` util (also used by save-time
    // detection in memory-store.ts) so the two features never diverge on the
    // definition of "similar".
    const centroids = new Float64Array(n * dim);
    for (let p = 0; p < n; p++) {
        const base = p * dim;
        const centroid = normalizedCentroid(usable[p].vectors);
        for (let d = 0; d < dim; d++) centroids[base + d] = centroid[d];
    }

    // With normalized centroids, cosine similarity is a plain dot product.
    // Collect every pair at/above the threshold, then merge greedily.
    const pairs: Array<{ i: number; j: number; sim: number }> = [];
    for (let i = 0; i < n; i++) {
        const baseI = i * dim;
        for (let j = i + 1; j < n; j++) {
            const baseJ = j * dim;
            let dot = 0;
            for (let d = 0; d < dim; d++) dot += centroids[baseI + d] * centroids[baseJ + d];
            if (dot >= threshold) {
                pairs.push({ i, j, sim: dot });
            }
        }
    }

    // Size-capped greedy agglomeration: process pairs strongest-first and
    // merge two components only if the result stays within
    // MAX_CLUSTER_MEMBERS. The cap prevents unreadably large clusters and
    // unbounded judge prompts, and — unlike a destructive truncation —
    // overflow spills into sibling clusters instead of being dropped, so
    // every clustered parent keeps its cluster and lowering the threshold
    // can only add candidates. Ties break on member ids for determinism.
    const pairKey = (p: { i: number; j: number }): string => {
        const idA = usable[p.i].id;
        const idB = usable[p.j].id;
        return idA < idB ? `${idA}\n${idB}` : `${idB}\n${idA}`;
    };
    pairs.sort((a, b) => {
        if (b.sim !== a.sim) return b.sim - a.sim;
        const aKey = pairKey(a);
        const bKey = pairKey(b);
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

    const dsu = new DisjointSet(n);
    const maxSimByIndex = new Float64Array(n);
    for (const { i, j, sim } of pairs) {
        if (dsu.find(i) === dsu.find(j)) continue;
        if (dsu.sizeOf(i) + dsu.sizeOf(j) > MAX_CLUSTER_MEMBERS) continue;
        dsu.union(i, j);
        // Pairs arrive strongest-first, so the first merge touching a
        // component records its max pairwise similarity.
        if (maxSimByIndex[i] === 0) maxSimByIndex[i] = sim;
        if (maxSimByIndex[j] === 0) maxSimByIndex[j] = sim;
    }

    const componentMembers = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const root = dsu.find(i);
        const members = componentMembers.get(root);
        if (members) {
            members.push(i);
        } else {
            componentMembers.set(root, [i]);
        }
    }

    const clusters: HygieneCluster[] = [];
    for (const indices of componentMembers.values()) {
        if (indices.length < 2) continue;
        const members: HygieneClusterMember[] = indices
            .map((index) => toMember(usable[index]))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const similarity = Math.max(...indices.map((index) => maxSimByIndex[index]));
        clusters.push({
            clusterId: clusterIdFor(members.map((m) => m.memoryId)),
            members,
            similarity,
        });
    }

    return clusters.sort((a, b) => b.similarity - a.similarity);
}

function toMember(parent: ParentVectorData): HygieneClusterMember {
    return {
        memoryId: parent.id,
        title: parent.title,
        createdAt: parent.createdAt,
        updatedAt: parent.updatedAt,
        contentLength: parent.fullContent.length,
    };
}
