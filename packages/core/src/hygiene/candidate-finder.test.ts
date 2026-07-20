import type { ParentVectorData } from '../memory/memory-store';
import {
    DEFAULT_HYGIENE_THRESHOLD,
    MAX_CLUSTER_MEMBERS,
    clusterIdFor,
    findCandidateClusters,
} from './candidate-finder';

const DIM = 4;

function axis(index: number, dim = DIM): number[] {
    const vec = new Array(dim).fill(0);
    vec[index] = 1;
    return vec;
}

function parent(id: string, vectors: number[][], updatedAt = 1_000): ParentVectorData {
    return {
        id,
        title: `title ${id}`,
        createdAt: updatedAt - 100,
        updatedAt,
        fullContent: `content of ${id}`,
        vectors,
    };
}

describe('findCandidateClusters', () => {
    it('clusters obvious duplicates together and leaves unrelated parents out', () => {
        const parents = [
            parent('dup-a', [axis(0)], 2_000),
            parent('dup-b', [axis(0)], 1_000),
            parent('other', [axis(1)], 3_000),
        ];
        const clusters = findCandidateClusters(parents, DEFAULT_HYGIENE_THRESHOLD);
        expect(clusters).toHaveLength(1);
        expect(clusters[0].members.map((m) => m.memoryId)).toEqual(['dup-a', 'dup-b']);
        expect(clusters[0].similarity).toBeCloseTo(1, 5);
    });

    it('sorts members newest-first and fills member metadata', () => {
        const parents = [
            parent('old', [axis(0)], 1_000),
            parent('new', [axis(0)], 9_000),
        ];
        const [cluster] = findCandidateClusters(parents, 0.9);
        expect(cluster.members.map((m) => m.memoryId)).toEqual(['new', 'old']);
        expect(cluster.members[0].title).toBe('title new');
        expect(cluster.members[0].contentLength).toBe('content of new'.length);
    });

    it('respects the threshold', () => {
        // cos([1,0],[1,1]/√2) ≈ 0.707 — below 0.8, above 0.5.
        const parents = [
            parent('a', [[1, 0, 0, 0]]),
            parent('b', [[1, 1, 0, 0]]),
        ];
        expect(findCandidateClusters(parents, 0.8)).toHaveLength(0);
        expect(findCandidateClusters(parents, 0.5)).toHaveLength(1);
    });

    it('uses the mean of all row vectors as the centroid', () => {
        // Parent 'multi' averages to the same direction as 'single'.
        const parents = [
            parent('multi', [[2, 0, 0, 0], [4, 0, 0, 0]]),
            parent('single', [[1, 0, 0, 0]]),
        ];
        const clusters = findCandidateClusters(parents, 0.99);
        expect(clusters).toHaveLength(1);
    });

    it('caps clusters at 8 by spilling overflow into sibling clusters — no member is dropped', () => {
        const parents = Array.from({ length: 10 }, (_, i) =>
            parent(`p${i}`, [axis(0)], (i + 1) * 1_000));
        const clusters = findCandidateClusters(parents, 0.9);
        const sizes = clusters.map((c) => c.members.length).sort((a, b) => b - a);
        expect(sizes).toEqual([MAX_CLUSTER_MEMBERS, 2]);
        // Every parent stays clustered.
        const clustered = clusters.flatMap((c) => c.members.map((m) => m.memoryId)).sort();
        expect(clustered).toEqual(parents.map((p) => p.id).sort());
    });

    it('splits a 12-member chain into 8 + 4 clusters with no members lost', () => {
        // A chain A~B, B~C, ... where adjacent pairs are near-identical: every
        // pair here is actually identical on the same axis, forming one big
        // above-threshold component that must spill instead of truncating.
        const parents = Array.from({ length: 12 }, (_, i) =>
            parent(`chain-${String(i).padStart(2, '0')}`, [axis(0)], (i + 1) * 1_000));
        const clusters = findCandidateClusters(parents, 0.9);
        const sizes = clusters.map((c) => c.members.length).sort((a, b) => b - a);
        expect(sizes).toEqual([MAX_CLUSTER_MEMBERS, 4]);
        const clustered = clusters.flatMap((c) => c.members.map((m) => m.memoryId)).sort();
        expect(clustered).toEqual(parents.map((p) => p.id).sort());
    });

    it('is deterministic across input order', () => {
        const parents = Array.from({ length: 12 }, (_, i) =>
            parent(`p${String(i).padStart(2, '0')}`, [axis(0)], (i + 1) * 1_000));
        const forward = findCandidateClusters(parents, 0.9);
        const reversed = findCandidateClusters([...parents].reverse(), 0.9);
        expect(forward.map((c) => c.clusterId).sort()).toEqual(reversed.map((c) => c.clusterId).sort());
    });

    it('lowering the threshold never yields fewer clusters or fewer clustered members', () => {
        // Pairs on mutually orthogonal axis planes (dim 8) with decreasing
        // in-pair similarity: 1.0, 0.9, 0.8, 0.72. Cross-pair similarity is 0,
        // so lowering the threshold reveals new pairs without bridging
        // existing clusters — the regression scenario where the old
        // truncating cap made lower thresholds return FEWER candidates.
        const dim = 8;
        const mixed = (a: number, b: number, sim: number): number[] => {
            const vec = new Array(dim).fill(0);
            vec[a] = sim;
            vec[b] = Math.sqrt(1 - sim * sim);
            return vec;
        };
        const parents = [
            parent('a1', [axis(0, dim)], 1_000),
            parent('a2', [axis(0, dim)], 2_000),
            parent('b1', [axis(2, dim)], 3_000),
            parent('b2', [mixed(2, 3, 0.9)], 4_000),
            parent('c1', [axis(4, dim)], 5_000),
            parent('c2', [mixed(4, 5, 0.8)], 6_000),
            parent('d1', [axis(6, dim)], 7_000),
            parent('d2', [mixed(6, 7, 0.72)], 8_000),
        ];
        // Descending thresholds — counts must be non-decreasing along the way.
        const thresholds = [0.95, 0.85, 0.75, 0.7];
        let prevClusters = -1;
        let prevMembers = -1;
        for (const threshold of thresholds) {
            const clusters = findCandidateClusters(parents, threshold);
            const memberCount = clusters.reduce((sum, c) => sum + c.members.length, 0);
            expect(clusters.length).toBeGreaterThanOrEqual(prevClusters);
            expect(memberCount).toBeGreaterThanOrEqual(prevMembers);
            prevClusters = clusters.length;
            prevMembers = memberCount;
        }
        expect(prevClusters).toBe(4);
        expect(prevMembers).toBe(8);
    });

    it('produces a stable clusterId regardless of member order', () => {
        const a = parent('a', [axis(0)], 1_000);
        const b = parent('b', [axis(0)], 2_000);
        const c = parent('c', [axis(1)], 3_000);
        const forward = findCandidateClusters([a, b, c], 0.9);
        const reversed = findCandidateClusters([c, b, a], 0.9);
        expect(forward[0].clusterId).toBe(reversed[0].clusterId);
        expect(forward[0].clusterId).toBe(clusterIdFor(['b', 'a']));
        expect(forward[0].clusterId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never emits single-member clusters', () => {
        const parents = [
            parent('a', [axis(0)]),
            parent('b', [axis(1)]),
            parent('c', [axis(2)]),
        ];
        expect(findCandidateClusters(parents, 0.8)).toHaveLength(0);
    });

    it('sorts clusters by similarity desc', () => {
        const parents = [
            parent('exact-1', [[1, 0, 0, 0]]),
            parent('exact-2', [[1, 0, 0, 0]]),
            parent('near-1', [[0, 1, 0, 0]]),
            parent('near-2', [[0, 1, 0.3, 0]]),
        ];
        const clusters = findCandidateClusters(parents, 0.8);
        expect(clusters).toHaveLength(2);
        expect(clusters[0].similarity).toBeGreaterThanOrEqual(clusters[1].similarity);
        expect(clusters[0].members.map((m) => m.memoryId).sort()).toEqual(['exact-1', 'exact-2']);
    });
});
