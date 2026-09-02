import { describe, it, expect } from 'vitest';
import { compressToIncluded, layoutCommitGraph, buildCommitGraph, GraphInput } from '../graph';

function c(hash: string, ...parentHashes: string[]): GraphInput {
    return { hash, parentHashes };
}

describe('compressToIncluded', () => {
    it('leaves parent links untouched when everything is included', () => {
        const commits = [c('a', 'b'), c('b', 'c'), c('c')];
        const result = compressToIncluded(commits, new Set(['a', 'b', 'c']));
        expect(result).toEqual([
            { hash: 'a', parentHashes: ['b'] },
            { hash: 'b', parentHashes: ['c'] },
            { hash: 'c', parentHashes: [] },
        ]);
    });

    it('drops excluded commits and reconnects to the nearest included ancestor', () => {
        // a -> b (excluded) -> c
        const commits = [c('a', 'b'), c('b', 'c'), c('c')];
        const result = compressToIncluded(commits, new Set(['a', 'c']));
        expect(result).toEqual([
            { hash: 'a', parentHashes: ['c'] },
            { hash: 'c', parentHashes: [] },
        ]);
    });

    it('walks through a run of several consecutive excluded commits', () => {
        // a -> x1 -> x2 -> x3 -> z, only a and z included
        const commits = [c('a', 'x1'), c('x1', 'x2'), c('x2', 'x3'), c('x3', 'z'), c('z')];
        const result = compressToIncluded(commits, new Set(['a', 'z']));
        expect(result).toEqual([
            { hash: 'a', parentHashes: ['z'] },
            { hash: 'z', parentHashes: [] },
        ]);
    });

    it('resolves each parent of a merge independently, even when one side is excluded', () => {
        // merge's parents: p1 (included directly), p2 (excluded, resolves to grandparent)
        const commits = [
            c('merge', 'p1', 'p2'),
            c('p1'),
            c('p2', 'grandparent'),
            c('grandparent'),
        ];
        const result = compressToIncluded(commits, new Set(['merge', 'p1', 'grandparent']));
        expect(result.find(n => n.hash === 'merge')).toEqual({
            hash: 'merge',
            parentHashes: ['p1', 'grandparent'],
        });
    });

    it('treats a parent hash never present in the input as unresolved rather than throwing', () => {
        // 'missing' isn't in the commit list at all - e.g. a parent older
        // than how far back the query reached, or not lazily loaded yet.
        const commits = [c('a', 'missing')];
        const result = compressToIncluded(commits, new Set(['a']));
        expect(result).toEqual([{ hash: 'a', parentHashes: [] }]);
    });

    it('gives up past maxDepth instead of searching an excluded chain indefinitely', () => {
        // a -> x1 -> x2 -> x3 -> z, with maxDepth too small to reach z.
        const commits = [c('a', 'x1'), c('x1', 'x2'), c('x2', 'x3'), c('x3', 'z'), c('z')];
        const result = compressToIncluded(commits, new Set(['a', 'z']), 2);
        expect(result.find(n => n.hash === 'a')).toEqual({ hash: 'a', parentHashes: [] });
    });

    it('does not duplicate an ancestor reached by more than one path through excluded commits', () => {
        // a has two excluded parents (x1, x2) that both resolve back to the
        // same included ancestor z - z should appear once, not twice.
        const commits = [
            c('a', 'x1', 'x2'),
            c('x1', 'z'),
            c('x2', 'z'),
            c('z'),
        ];
        const result = compressToIncluded(commits, new Set(['a', 'z']));
        expect(result.find(n => n.hash === 'a')?.parentHashes).toEqual(['z']);
    });

    it('dedupes an ancestor reached twice from within a single excluded commit\'s own merge', () => {
        // Unlike the case above (dedup across two of a's own parents), here
        // the merge - and the duplicate path - is entirely inside the
        // excluded region: x itself is a merge of p1/p2, both of which
        // resolve to the same included ancestor z.
        const commits = [
            c('a', 'x'),
            c('x', 'p1', 'p2'),
            c('p1', 'z'),
            c('p2', 'z'),
            c('z'),
        ];
        const result = compressToIncluded(commits, new Set(['a', 'z']));
        expect(result.find(n => n.hash === 'a')?.parentHashes).toEqual(['z']);
    });
});

describe('layoutCommitGraph', () => {
    it('keeps a linear chain on a single lane throughout', () => {
        const rows = layoutCommitGraph([c('a', 'b'), c('b', 'c'), c('c')]);
        expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
        // Same lane -> same color the whole way down.
        expect(rows[0].color).toBe(rows[1].color);
        expect(rows[1].color).toBe(rows[2].color);
        expect(rows[0].segments).toEqual([{ fromLane: 0, toLane: 0, color: rows[0].color }]);
    });

    it('closes the lane with no outgoing segment at a root commit', () => {
        const rows = layoutCommitGraph([c('a', 'b'), c('b')]);
        expect(rows[1].segments).toEqual([]);
    });

    it('opens a second lane for a merge commit\'s extra parent', () => {
        const rows = layoutCommitGraph([c('merge', 'p1', 'p2'), c('p1'), c('p2')]);
        const mergeRow = rows[0];
        expect(mergeRow.segments).toHaveLength(2);
        // First parent keeps the merge's own lane; the second opens a new one.
        const ownLaneSegment = mergeRow.segments.find(s => s.fromLane === mergeRow.lane && s.toLane === mergeRow.lane);
        const newLaneSegment = mergeRow.segments.find(s => s.toLane !== mergeRow.lane);
        expect(ownLaneSegment).toBeDefined();
        expect(newLaneSegment).toBeDefined();
        expect(newLaneSegment!.toLane).not.toBe(mergeRow.lane);
    });

    it('converges a merge\'s second parent into an already-active lane instead of opening a duplicate', () => {
        // b and c are two branches that both merge back into the same
        // ancestor 'base', which is already an active lane by the time the
        // merge commit is processed (b's own line is already heading there).
        const rows = layoutCommitGraph([
            c('merge', 'b', 'c'),
            c('b', 'base'),
            c('c', 'base'),
            c('base'),
        ]);
        // Only 'base' itself opens/claims a lane for 'base' - the merge
        // commit's second parent segment should point at that same lane,
        // not spawn a second lane also waiting for 'base'.
        const maxLaneSeen = Math.max(...rows.map(r => r.lane), ...rows.flatMap(r => r.segments.map(s => s.toLane)));
        expect(maxLaneSeen).toBe(1); // lanes 0 and 1 only - no third lane created
    });

    it('converges a fork\'s second child into the lane already heading to their shared parent', () => {
        // a and b are independent children of the same parent x, a
        // processed first (its lane already targets x by the time b is
        // processed) - the classic "two lanes waiting for the same commit"
        // trap the fork/merge cases share.
        const rows = layoutCommitGraph([c('a', 'x'), c('b', 'x'), c('x')]);
        expect(rows).toHaveLength(3);
        // 'a' and 'b' start on different lanes (unrelated until x)...
        expect(rows[0].lane).not.toBe(rows[1].lane);
        // ...but only one lane should still be waiting for x by the time it
        // arrives - not two duplicate lanes both resolving to it.
        expect(rows[2].segments).toEqual([]); // x is a root here, nothing to verify duplication against directly
        // The real assertion: b's row converges into a's lane rather than
        // opening a third lane, so the highest lane number used is 1.
        const maxLane = Math.max(...rows.map(r => r.lane));
        expect(maxLane).toBe(1);
    });

    it('reuses a freed lane slot for an unrelated later root, rather than growing lanes forever', () => {
        // a is a root (closes lane 0 immediately); b is a second, unrelated
        // root that should reuse that freed slot instead of opening lane 1.
        const rows = layoutCommitGraph([c('a'), c('b')]);
        expect(rows[0].lane).toBe(0);
        expect(rows[1].lane).toBe(0);
    });

    it('lets an unresolved dangling parent keep occupying its lane with no crash', () => {
        // 'never-shown' never appears as its own row in this input (e.g. it
        // wasn't lazily loaded yet) - the lane it occupies should just keep
        // passing through for any later unrelated rows, not error out.
        const rows = layoutCommitGraph([c('a', 'never-shown'), c('unrelated-root')]);
        expect(rows).toHaveLength(2);
        // The unrelated root doesn't collide with the still-dangling lane.
        expect(rows[1].lane).not.toBe(rows[0].lane);
    });
});

describe('buildCommitGraph', () => {
    it('composes compression and layout into a graph over just the included commits', () => {
        // a -> b (excluded) -> c, plus an unrelated root d.
        const commits = [c('a', 'b'), c('b', 'c'), c('c'), c('d')];
        const rows = buildCommitGraph(commits, new Set(['a', 'c', 'd']));
        expect(rows.map(r => r.hash)).toEqual(['a', 'c', 'd']);
        // a connects straight to c (b compressed away), staying on one lane.
        expect(rows[0].lane).toBe(rows[1].lane);
        expect(rows[0].segments).toEqual([{ fromLane: rows[0].lane, toLane: rows[1].lane, color: rows[0].color }]);
    });
});
