// Commit-graph layout: turns a list of {hash, parentHashes} into per-row
// lane positions + connecting line segments a renderer can draw directly,
// with no DOM/rendering concerns here - see main.ts for the SVG column
// that consumes this. Two composable stages:
//
//   1. compressToIncluded() - collapses the real parent chain down to just
//      the commits actually being shown, so a filtered view or a
//      path-scoped log (File Log/Folder View, whose query never returns
//      commits that didn't touch that path) still gets a graph that
//      connects each visible commit straight to its nearest visible
//      ancestor(s), instead of dangling on a parent hash that was never
//      rendered.
//   2. layoutCommitGraph() - the actual lane assignment over that (possibly
//      compressed) edge list.
//
// Both are pure and DAG-shaped (no git, no DOM), so they're tested here
// directly against synthetic commit graphs rather than through rendered
// DOM output - see src/__tests__/gitService.test.ts's parseLogOutput tests
// for the same "test the pure parsing/data function directly" precedent.

export interface GraphInput {
    hash: string;
    parentHashes: string[];
}

export interface CompressedNode {
    hash: string;
    parentHashes: string[];
}

/**
 * Rewrites each included commit's parents to the nearest included
 * ancestor(s), walking the real parent chain and skipping anything not in
 * `included`. Commits not in `included` are dropped from the output
 * entirely - only their edges survive, folded into whichever included
 * descendant(s) reach them.
 *
 * `maxDepth` bounds both the recursion depth (protects the call stack on a
 * pathological chain) and the search cost: a branch that never reaches an
 * included commit within `maxDepth` real hops is treated as unresolved
 * (dropped, same as a parent that was never fetched at all) rather than
 * searched indefinitely.
 *
 * `allCommits` must not contain the same hash twice (e.g. a caller merging
 * two overlapping data sources needs to dedupe first) - each occurrence
 * produces its own output entry, so a duplicate silently double-processes
 * that commit rather than erroring.
 */
export function compressToIncluded(
    allCommits: GraphInput[],
    included: ReadonlySet<string>,
    maxDepth = 500,
): CompressedNode[] {
    const byHash = new Map(allCommits.map(c => [c.hash, c]));

    function nearestIncludedAncestors(hash: string, depth: number): string[] {
        if (included.has(hash)) return [hash];
        if (depth >= maxDepth) return [];
        const commit = byHash.get(hash);
        // Not part of the fetched graph at all - either the edge of how far
        // back the data reaches, or (for the main-log/filter case, where
        // allCommits IS the full fetched set) a parent not lazily loaded
        // yet. Either way, this branch just dangles unresolved.
        if (!commit) return [];
        const result: string[] = [];
        for (const parent of commit.parentHashes) {
            for (const ancestor of nearestIncludedAncestors(parent, depth + 1)) {
                if (!result.includes(ancestor)) result.push(ancestor);
            }
        }
        return result;
    }

    const output: CompressedNode[] = [];
    for (const commit of allCommits) {
        if (!included.has(commit.hash)) continue;
        const parentHashes: string[] = [];
        for (const parent of commit.parentHashes) {
            for (const ancestor of nearestIncludedAncestors(parent, 1)) {
                if (!parentHashes.includes(ancestor)) parentHashes.push(ancestor);
            }
        }
        output.push({ hash: commit.hash, parentHashes });
    }
    return output;
}

export interface GraphSegment {
    fromLane: number;
    toLane: number;
    color: string;
}

export interface GraphRow {
    hash: string;
    lane: number;
    color: string;
    // Line segments spanning from this row down toward the next row (a
    // straight passthrough has fromLane === toLane; a diagonal branch/merge
    // doesn't). The last row's segments (if any - an unresolved/dangling
    // parent has none) just run off the bottom of the rendered rows.
    segments: GraphSegment[];
}

// Same hue-stepping approach as blame's per-commit row coloring (see
// `hue = (i * 47) % 360` in main.ts) for a consistent, cheap way to spread
// colors apart without a fixed palette running out. Higher lightness/no
// alpha here versus blame's 0.12-alpha background tint - these are drawn as
// opaque line strokes, not a wash under text, so they need to read clearly
// against both light and dark VS Code themes on their own.
function laneColor(laneOpenIndex: number): string {
    const hue = (laneOpenIndex * 47) % 360;
    return `hsl(${hue}, 70%, 55%)`;
}

/**
 * Standard lane-assignment algorithm for a commit graph: walks `commits` in
 * the order given (must already be topological - i.e. exactly the order
 * git log/compressToIncluded produces, a child before its parents) and
 * assigns each one a lane, reusing a lane across a straight single-parent
 * run and opening a new one for each extra merge parent.
 *
 * Two DAG shapes collapse to the same handling here, which is why parent
 * assignment below is one uniform loop rather than "first parent" being a
 * special case: a fork (two children both eventually reaching the same
 * ancestor) looks, from the second child's perspective, identical to a
 * merge's second parent already being tracked by another lane - both are
 * "this parent hash is already claimed elsewhere, converge into that lane
 * instead of opening a duplicate one waiting for the same commit twice."
 */
export function layoutCommitGraph(commits: GraphInput[] | CompressedNode[]): GraphRow[] {
    // lanes[i] = the hash lane i is currently waiting for, or null if free
    // (a freed slot gets reused by the next lane that needs to open).
    const lanes: (string | null)[] = [];
    const laneColors: string[] = [];
    let nextColorIndex = 0;

    function allocateLane(hash: string): number {
        const free = lanes.indexOf(null);
        const idx = free === -1 ? lanes.length : free;
        lanes[idx] = hash;
        laneColors[idx] = laneColor(nextColorIndex++);
        return idx;
    }

    const rows: GraphRow[] = [];

    for (const commit of commits) {
        let lane = lanes.indexOf(commit.hash);
        if (lane === -1) {
            // Nothing anticipated this commit - either the very first row,
            // or (in a multi-branch/"All" scope) a root of history that
            // isn't reachable from anything shown above it.
            lane = allocateLane(commit.hash);
        }
        const color = laneColors[lane];
        const segments: GraphSegment[] = [];

        // Every other currently-active lane just passes straight through
        // this row, unaffected by this commit.
        for (let i = 0; i < lanes.length; i++) {
            if (i !== lane && lanes[i] !== null) {
                segments.push({ fromLane: i, toLane: i, color: laneColors[i] });
            }
        }

        // Free this commit's own lane, then let each parent claim either
        // this same lane (whichever parent gets there first, keeping the
        // common single-parent case a straight line) or converge into
        // whatever lane already targets it. Any remaining parent beyond
        // that opens a genuinely new lane - a merge branching out.
        lanes[lane] = null;
        let ownLaneClaimed = false;

        for (const parentHash of commit.parentHashes) {
            const existing = lanes.indexOf(parentHash);
            if (existing !== -1) {
                segments.push({ fromLane: lane, toLane: existing, color });
            } else if (!ownLaneClaimed) {
                lanes[lane] = parentHash;
                laneColors[lane] = color;
                segments.push({ fromLane: lane, toLane: lane, color });
                ownLaneClaimed = true;
            } else {
                const newLane = allocateLane(parentHash);
                segments.push({ fromLane: lane, toLane: newLane, color: laneColors[newLane] });
            }
        }

        rows.push({ hash: commit.hash, lane, color, segments });
    }

    return rows;
}

/** Composes both stages - the entry point a renderer actually calls. */
export function buildCommitGraph(
    allCommits: GraphInput[],
    included: ReadonlySet<string>,
    maxDepth = 500,
): GraphRow[] {
    return layoutCommitGraph(compressToIncluded(allCommits, included, maxDepth));
}
