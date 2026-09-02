import { sortArray, statusClass, statusLabel, escapeHtml, formatDate, formatTimeAgo } from './utils';
import { buildCommitGraph, GraphRow } from './graph';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

interface Commit {
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    authorDate: string;
    refs: string;
    parentHashes: string[];
}

interface CommitDetail {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    authorDate: string;
    body: string;
}

interface FileChange {
    path: string;
    oldPath?: string;
    status: string;
    additions: number;
    deletions: number;
    parentGroup?: string;
}

interface InitialState {
    mode: 'log' | 'compare' | 'blame';
    targetPath?: string;
    isFile?: boolean;
    sha1?: string;
    sha2?: string;
    blameSha?: string;
    blameFilePath?: string;
    lineStart?: number;
    lineEnd?: number;
    pageSize?: number;
}

const vscode = acquireVsCodeApi();
const state: InitialState = (window as unknown as { initialState: InitialState }).initialState;

let allCommits: Commit[] = [];
// Only ever populated for a path-scoped view's first page (see
// renderCommitGraph()'s use of it) - real, unscoped parent-hash data the
// commit graph needs to connect around commits `allCommits` itself never
// returns. Stays empty for the main (unscoped) log, which never needs it.
let graphEdges: Commit[] = [];
let allFiles: FileChange[] = [];
const selectedCommitShas: string[] = [];
let fileListCommitSha: string | null = null;
let hasMore = true;
let loading = false;
// Tracks the sha of the most recent requestCommitDetails call, so a
// commitDetailsLoaded response can be dropped if it's not for the current
// selection. Typing quickly into a commit-list filter re-selects the first
// visible row on every keystroke, firing one request per keystroke; without
// this guard, an intermediate row's response arriving after the final one
// silently overwrites the detail panel/file list with the wrong commit.
let latestRequestedDetailSha: string | null = null;

let folderViewEnabled = false;

let commitSortColumn: keyof Commit | null = null;
let commitSortAsc = false;
let fileSortColumn: keyof FileChange = 'path';
let fileSortAsc = true;

// --- DOM refs (may be null in compare mode) ---
const commitTbody = document.getElementById('commit-tbody') as HTMLTableSectionElement | null;
const commitDetailPanel = document.getElementById('commit-detail-panel');
const filesTbody = document.getElementById('files-tbody') as HTMLTableSectionElement;
const loadMore = document.getElementById('load-more');
const contextMenu = document.getElementById('context-menu')!;
const commitContextMenu = document.getElementById('commit-context-menu');

// --- Sorting ---

function updateSortArrows(tableId: string, column: string, asc: boolean): void {
    const table = document.getElementById(tableId);
    if (!table) return;
    table.querySelectorAll('th .sort-arrow').forEach(el => el.textContent = '');
    const th = table.querySelector(`th[data-col="${column}"]`);
    if (th) {
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) {
            arrow.textContent = asc ? ' ▲' : ' ▼';
        }
    }
}

// --- Commit list rendering (log mode only) ---

function renderCommits(): void {
    if (!commitTbody) return;
    const sorted = commitSortColumn
        ? sortArray(allCommits, commitSortColumn, commitSortAsc)
        : allCommits;
    commitTbody.innerHTML = '';
    for (const commit of sorted) {
        const tr = document.createElement('tr');
        tr.className = 'data-row';
        if (selectedCommitShas.includes(commit.hash)) {
            tr.classList.add('selected');
        }
        tr.dataset.sha = commit.hash;

        // Populated by renderCommitGraph() below, after this loop and after
        // any active filter has been (re)applied - it needs to know which
        // rows ended up filtered-out before it can decide what's "included"
        // for the graph, and that's DOM state this loop hasn't produced yet.
        const tdGraph = document.createElement('td');
        tdGraph.className = 'col-graph';
        tr.appendChild(tdGraph);

        const tdSha = document.createElement('td');
        tdSha.className = 'col-sha';
        tdSha.textContent = commit.shortHash;
        tr.appendChild(tdSha);

        const tdMsg = document.createElement('td');
        tdMsg.className = 'col-message';
        if (commit.refs) {
            commit.refs.split(', ').forEach(ref => {
                const badge = document.createElement('span');
                const trimmed = ref.trim();
                if (trimmed.startsWith('tag:')) {
                    badge.className = 'ref-pill ref-tag';
                    badge.textContent = trimmed.substring(5);
                } else if (trimmed.startsWith('HEAD')) {
                    badge.className = 'ref-pill ref-head';
                    badge.textContent = trimmed;
                } else {
                    badge.className = 'ref-pill ref-branch';
                    badge.textContent = trimmed;
                }
                tdMsg.appendChild(badge);
            });
        }
        const msgText = document.createElement('span');
        msgText.textContent = commit.subject;
        tdMsg.appendChild(msgText);
        tdMsg.title = commit.subject;
        tr.appendChild(tdMsg);

        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'col-author';
        tdAuthor.textContent = commit.authorName;
        tr.appendChild(tdAuthor);

        const tdDate = document.createElement('td');
        tdDate.className = 'col-date';
        tdDate.textContent = formatDate(commit.authorDate);
        tdDate.dataset.rawDate = commit.authorDate;
        tr.appendChild(tdDate);

        tr.addEventListener('click', (e) => onCommitClick(commit.hash, e));
        tr.addEventListener('contextmenu', (e) => showCommitContextMenu(e));
        commitTbody.appendChild(tr);
    }
    if (hasActiveFilters()) {
        applyFilters(false);
    } else {
        // applyFilters() (below) is what calls renderCommitGraph() after it
        // updates filtered-out state - with no active filter it never runs
        // above, so the graph still needs building here.
        renderCommitGraph(sorted);
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_LANE_WIDTH = 14;
// Real DEFAULT_ROW_HEIGHT is only the pre-first-render fallback - actual
// rendering always uses a value measured fresh off a real row (see
// renderCommitGraph), since row height depends on the user's font-size
// setting and isn't something to hardcode.
const DEFAULT_ROW_HEIGHT = 22;

function laneX(lane: number): number {
    return lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
}

// A straight-line diagonal reads as a sharp kink at every row it crosses
// through, even where the geometry is mathematically continuous (see
// appendGraphCurve below for how the halves themselves join seamlessly) -
// an S-curve reads as one smooth lane change instead. The curve's control
// points sit directly above/below its own endpoints (same x, at the
// vertical midpoint) rather than pulled toward the opposite endpoint - that
// makes the tangent AT each endpoint perfectly vertical, so a straight
// passthrough segment butting up against this curve (or this curve's other
// half, across the row boundary) meets it with no visible direction change.
// A same-lane segment (x1 === x2) degenerates to a straight vertical line
// automatically - the control points collapse onto the line itself - so
// this is safe to use unconditionally rather than special-casing straight
// runs separately.
function appendGraphCurve(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number, color: string): void {
    const midY = (y1 + y2) / 2;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
}

// data-sha (not a native <title>) is what lets the hover-tooltip listener
// (delegated on commitTbody - see setupGraphTooltip) identify which commit
// a given dot represents. A native title tooltip can only show static text
// set up front; this dot's tooltip content (which branches/tags contain
// it) needs an on-demand git query per hover, so it has to be a custom
// element that can start in a loading state and fill in asynchronously.
function appendGraphDot(svg: SVGSVGElement, x: number, y: number, r: number, color: string, sha: string, parentHashes: string[]): void {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(x));
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', color);
    // Plain attributes rather than .dataset - SVGElement.dataset write
    // support is inconsistent enough (including in the jsdom test
    // environment) not to rely on, where a plain data-* attribute works
    // universally for both setting and reading back. data-parents carries
    // the tooltip's parent-hash line without needing a commitsByHash
    // lookup at hover time (that map is local to renderCommitGraph()).
    circle.setAttribute('data-sha', sha);
    circle.setAttribute('data-parents', parentHashes.join(','));
    svg.appendChild(circle);
}

/**
 * Builds one row's graph cell. Each row's SVG only spans that row's own
 * height, but a diagonal (branch/merge) segment visually crosses a row
 * boundary - so a segment gets drawn as two halves, one by the row it
 * belongs to (its lower half, ending at the boundary) and one by the row
 * below it (that same segment's upper half, starting at the boundary).
 * Both halves are anchored to the same midpoint x (the average of the
 * segment's two lane positions) so they meet with no visible seam - see
 * `ownSegments`/`incomingSegments` below for which half is whose job.
 *
 * The viewBox is set to the row's REAL pixel dimensions (rowHeight is
 * measured off an actual row - see renderCommitGraph), not an abstract 0..1
 * box stretched to fit via preserveAspectRatio="none". Non-uniform
 * stretching scales x and y differently, which distorts stroke geometry
 * along with the path itself - a round linecap/join becomes elliptical,
 * most visibly right at a curve's bend where the local tangent direction
 * is neither purely horizontal nor vertical. Matching the viewBox to real
 * pixels 1:1 keeps stroke width and rounding uniform in both directions.
 */
function buildGraphCellSvg(row: GraphRow, incomingSegments: GraphRow['segments'], laneCount: number, rowHeight: number, commit: Commit): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('viewBox', `0 0 ${laneCount * GRAPH_LANE_WIDTH} ${rowHeight}`);
    svg.classList.add('commit-graph-svg');

    const midY = rowHeight / 2;

    // Upper half: segments entering from the row above, ending at their
    // shared midpoint with that row's own lower half.
    for (const seg of incomingSegments) {
        const fromX = laneX(seg.fromLane);
        const toX = laneX(seg.toLane);
        const midX = (fromX + toX) / 2;
        appendGraphCurve(svg, midX, 0, toX, midY, seg.color);
    }
    // Lower half: this row's own segments, starting at this row's node/
    // passthrough position and ending at the midpoint the row below
    // continues from.
    for (const seg of row.segments) {
        const fromX = laneX(seg.fromLane);
        const toX = laneX(seg.toLane);
        const midX = (fromX + toX) / 2;
        appendGraphCurve(svg, fromX, midY, midX, rowHeight, seg.color);
    }

    // A dot marks "a commit happened here" - a passthrough lane doesn't
    // have one on this row (its own commit is elsewhere), so it stays a
    // plain line with no dot. Exactly one dot per row: the row's own
    // commit.
    appendGraphDot(svg, laneX(row.lane), midY, GRAPH_LANE_WIDTH * 0.32, row.color, commit.hash, commit.parentHashes);

    return svg;
}

/**
 * Draws the commit-graph column into the rows renderCommits() already
 * built. Split out on its own (rather than inlined at the end of
 * renderCommits()) because it also has to re-run on plain filtering, which
 * never calls renderCommits() itself - see applyFilters()'s call to this.
 *
 * Only meaningful in git's own log order - sorting by Author or Date would
 * draw lines between rows that aren't actually adjacent in the real
 * history, which is worse than no graph at all, so a non-default sort just
 * hides the column entirely rather than drawing a misleading one.
 */
function renderCommitGraph(sorted: Commit[]): void {
    const table = document.getElementById('commit-table');
    // Unreachable in practice: both call sites (renderCommits(), and
    // applyFilters()'s log-mode branch) only ever run once #commit-table's
    // static HTML - which always includes both #commit-table itself and
    // commitTbody (#commit-tbody) together - has already been parsed into
    // the DOM. Left in as a guard against a future call site that isn't
    // guaranteed that, rather than assuming there can never be one.
    /* v8 ignore next */
    if (!table || !commitTbody) return;

    // Line History's commits are a line's own provenance, not commit
    // topology - git's -L mode isn't designed to be graphed (unlike a
    // plain path-scoped log, whose commits are still real DAG nodes just
    // filtered down to ones that touched that path). Hidden here rather
    // than fetching graphEdges support for it server-side too.
    if (state.lineStart && state.lineEnd) {
        table.classList.add('graph-hidden');
        return;
    }

    if (commitSortColumn !== null) {
        table.classList.add('graph-hidden');
        return;
    }
    table.classList.remove('graph-hidden');

    const included = new Set<string>();
    const rowsBySha = new Map<string, HTMLTableRowElement>();
    commitTbody.querySelectorAll<HTMLTableRowElement>('tr.data-row').forEach(tr => {
        const sha = tr.dataset.sha;
        // Unreachable in practice: renderCommits() unconditionally sets
        // tr.dataset.sha on every row it builds, and .data-row only ever
        // matches rows it built. Guard kept for the same reason as above -
        // dataset.sha not being guaranteed by TypeScript's own types.
        /* v8 ignore next */
        if (!sha) return;
        rowsBySha.set(sha, tr);
        if (!tr.classList.contains('filtered-out')) {
            included.add(sha);
        }
    });

    // buildCommitGraph()'s first argument doubles as both the set of rows
    // to actually produce (governed by `included`) and the lookup data its
    // compression pass walks through to connect around anything excluded.
    // For the main log those are the same list; for a path-scoped view
    // (File Log, Folder View) graphEdges supplies the real ancestry `sorted`
    // itself doesn't have (see onRequestCommits on the extension host).
    //
    // A recent scoped commit is quite likely to also fall within
    // graphEdges' own (recent, unscoped) batch - the two aren't disjoint -
    // so this dedupes by hash rather than plain-concatenating: iterating
    // the same hash twice would make compressToIncluded's output (and so
    // layoutCommitGraph's lane assignment) process it twice too, not just
    // waste a little work. Which copy wins doesn't matter for correctness
    // (git's %P for a given hash is the same real data regardless of which
    // query returned it) - `sorted` is picked arbitrarily, over graphEdges.
    const sortedHashes = new Set(sorted.map(c => c.hash));
    const graphInput = sorted.concat(graphEdges.filter(c => !sortedHashes.has(c.hash)));
    const graphRows = buildCommitGraph(
        graphInput.map(c => ({ hash: c.hash, parentHashes: c.parentHashes })),
        included,
    );
    const commitsByHash = new Map(sorted.map(c => [c.hash, c]));

    const laneCount = Math.max(
        1,
        ...graphRows.map(r => r.lane + 1),
        ...graphRows.flatMap(r => r.segments.map(s => Math.max(s.fromLane, s.toLane) + 1)),
    );

    const graphHeader = table.querySelector<HTMLElement>('th.col-graph');
    if (graphHeader) {
        graphHeader.style.width = `${laneCount * GRAPH_LANE_WIDTH}px`;
    }

    // Measured off a real row rather than assumed, so the graph's own pixel
    // math (see buildGraphCellSvg) always matches actual row height - which
    // depends on the user's font-size setting, not something to hardcode.
    // jsdom (the test environment) has no real layout engine and always
    // reports 0 here, so DEFAULT_ROW_HEIGHT is what every existing test
    // actually exercises - a real browser only falls back to it if a row's
    // rect legitimately measures 0 (nothing rendered yet).
    const measuredHeight = commitTbody.querySelector('tr.data-row')?.getBoundingClientRect().height;
    const rowHeight = measuredHeight ? measuredHeight : DEFAULT_ROW_HEIGHT;

    for (let i = 0; i < graphRows.length; i++) {
        const row = graphRows[i];
        const tr = rowsBySha.get(row.hash);
        const td = tr?.querySelector<HTMLElement>('td.col-graph');
        // Unreachable in practice: `row.hash` always came from `sorted`,
        // the same commit list rowsBySha was just built from, and every
        // row renderCommits() builds always includes a td.col-graph as its
        // first cell.
        /* v8 ignore next */
        if (!td) continue;
        const incoming = i > 0 ? graphRows[i - 1].segments : [];
        const commit = commitsByHash.get(row.hash);
        // Unreachable in practice: same reasoning as the td guard above -
        // row.hash always came from `sorted`, the same list commitsByHash
        // was just built from.
        /* v8 ignore next */
        if (!commit) continue;
        td.replaceChildren(buildGraphCellSvg(row, incoming, laneCount, rowHeight, commit));
    }
}

// --- Commit graph dot tooltip (log mode only) ---
//
// Everything the *row itself* already shows (hash, subject, author, date)
// deliberately stays off this tooltip - it would just repeat the adjacent
// columns. What it shows instead is what no column does: parent hashes
// (free - already have this client-side, and the only place a merge
// commit's own parents are ever written out as text rather than just
// implied by the graph's shape) and which branches/tags actually contain
// this commit (real reachability, not the rare direct-decoration ref-pill
// badges already shown inline in the Message column). The refs need a
// per-commit git query this app doesn't run anywhere else, so unlike
// everything else drawn eagerly into the graph column, that part is
// fetched lazily - only for a commit someone actually hovers, after a
// short delay so a mouse merely passing over several dots doesn't fire a
// git call for every one of them.

const graphTooltip = document.getElementById('commit-graph-tooltip');
const GRAPH_TOOLTIP_HOVER_DELAY = 150;
const commitRefsCache = new Map<string, { branches: string[]; tags: string[] }>();
const inFlightRefsRequests = new Set<string>();
let graphTooltipShowTimer: ReturnType<typeof setTimeout> | null = null;
// Which commit the tooltip is currently showing (or about to show) for,
// and its parent hashes (known up front, unlike branches/tags - carried
// alongside so renderGraphTooltipContent doesn't need commitsByHash, which
// is local to renderCommitGraph()). Lets a commitRefsLoaded response that
// arrives after the user has already moved on to a different dot (or away
// entirely) update the cache without clobbering what's actually on screen.
let currentTooltipSha: string | null = null;
let currentTooltipParents: string[] = [];

// Same .ref-pill/.ref-branch/.ref-tag classes renderCommits() already uses
// for the inline badges on a commit's own %D-decoration refs (see its
// commit.refs handling) - one visual language for "here's a ref name"
// everywhere it appears, not a second pill style invented just for this.
function buildRefPills(names: string[], cssClass: string): string {
    return names.map(name => `<span class="ref-pill ${cssClass}">${escapeHtml(name)}</span>`).join('');
}

function renderGraphTooltipContent(sha: string): void {
    if (!graphTooltip) return;
    const rows: string[] = [];
    if (currentTooltipParents.length > 0) {
        const shortParents = currentTooltipParents.map(p => p.slice(0, 7));
        rows.push(`<div class="tooltip-row"><span class="tooltip-label">${currentTooltipParents.length > 1 ? 'Parents' : 'Parent'}: </span>${escapeHtml(shortParents.join(', '))}</div>`);
    }
    const cached = commitRefsCache.get(sha);
    if (!cached) {
        rows.push('<div class="tooltip-row">Loading branches/tags…</div>');
        graphTooltip.innerHTML = rows.join('');
        return;
    }
    if (cached.branches.length > 0) {
        rows.push(`<div class="tooltip-row"><span class="tooltip-label">Branches: </span>${buildRefPills(cached.branches, 'ref-branch')}</div>`);
    }
    if (cached.tags.length > 0) {
        rows.push(`<div class="tooltip-row"><span class="tooltip-label">Tags: </span>${buildRefPills(cached.tags, 'ref-tag')}</div>`);
    }
    // A commit can genuinely be on neither - reachable only from a ref
    // that's since been deleted, or from the reflog alone - rare, but
    // silently showing nothing beyond parents would look broken rather
    // than "nothing more to show".
    if (cached.branches.length === 0 && cached.tags.length === 0) {
        rows.push('<div class="tooltip-row">Not on any current branch or tag</div>');
    }
    graphTooltip.innerHTML = rows.join('');
}

function showGraphTooltipFor(sha: string, parentHashes: string[], clientX: number, clientY: number): void {
    if (!graphTooltip) return;
    currentTooltipSha = sha;
    currentTooltipParents = parentHashes;
    renderGraphTooltipContent(sha);
    // Offset from the cursor rather than directly under it - purely
    // cosmetic (pointer-events: none on the tooltip means it can never
    // actually block the dot underneath from receiving mouseout).
    graphTooltip.style.left = `${clientX + 12}px`;
    graphTooltip.style.top = `${clientY + 12}px`;
    graphTooltip.style.display = 'block';
    clampMenu(graphTooltip);

    if (!commitRefsCache.has(sha) && !inFlightRefsRequests.has(sha)) {
        inFlightRefsRequests.add(sha);
        vscode.postMessage({ type: 'requestCommitRefs', sha });
    }
}

function hideGraphTooltip(): void {
    currentTooltipSha = null;
    if (graphTooltipShowTimer) {
        clearTimeout(graphTooltipShowTimer);
        graphTooltipShowTimer = null;
    }
    if (graphTooltip) graphTooltip.style.display = 'none';
}

if (commitTbody) {
    commitTbody.addEventListener('mouseover', (e) => {
        const dot = (e.target as Element).closest?.('circle[data-sha]');
        if (!dot) return;
        const sha = dot.getAttribute('data-sha');
        if (!sha || sha === currentTooltipSha) return;
        const parentHashes = (dot.getAttribute('data-parents') || '').split(',').filter(Boolean);
        if (graphTooltipShowTimer) clearTimeout(graphTooltipShowTimer);
        const { clientX, clientY } = e;
        graphTooltipShowTimer = setTimeout(() => {
            graphTooltipShowTimer = null;
            showGraphTooltipFor(sha, parentHashes, clientX, clientY);
        }, GRAPH_TOOLTIP_HOVER_DELAY);
    });
    commitTbody.addEventListener('mouseout', (e) => {
        if (!(e.target as Element).closest?.('circle[data-sha]')) return;
        hideGraphTooltip();
    });
}

function selectFirstVisibleCommit(): void {
    if (!commitTbody) return;
    const firstVisible = commitTbody.querySelector('tr.data-row:not(.filtered-out)') as HTMLElement | null;
    if (firstVisible && firstVisible.dataset.sha) {
        onCommitClick(firstVisible.dataset.sha, new MouseEvent('click'));
    } else {
        clearDetailPanels();
    }
}

function clearDetailPanels(): void {
    selectedCommitShas.length = 0;
    fileListCommitSha = null;
    if (commitTbody) {
        commitTbody.querySelectorAll('tr').forEach(tr => tr.classList.remove('selected'));
    }
    if (commitDetailPanel) {
        commitDetailPanel.innerHTML = '<div class="empty-state">No commits to display</div>';
    }
    allFiles = [];
    if (filesTbody) filesTbody.innerHTML = '';
}

function onCommitClick(sha: string, e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey) {
        const idx = selectedCommitShas.indexOf(sha);
        if (idx >= 0) {
            selectedCommitShas.splice(idx, 1);
        } else {
            if (selectedCommitShas.length >= 2) {
                selectedCommitShas.shift();
            }
            selectedCommitShas.push(sha);
        }
    } else {
        selectedCommitShas.length = 0;
        selectedCommitShas.push(sha);
    }

    if (commitTbody) {
        commitTbody.querySelectorAll('tr').forEach(tr => {
            tr.classList.toggle('selected', selectedCommitShas.includes(tr.dataset.sha || ''));
        });
    }

    if (selectedCommitShas.length === 1) {
        latestRequestedDetailSha = sha;
        vscode.postMessage({ type: 'requestCommitDetails', sha });
    }
}

// --- Commit context menu (log mode) ---

function showCommitContextMenu(e: MouseEvent): void {
    if (!commitContextMenu) return;
    e.preventDefault();
    e.stopPropagation();

    const compareRevItem = document.getElementById('ctx-compare-revisions');
    const compareSeparator = document.getElementById('ctx-compare-separator');
    const commitClearFilters = document.getElementById('ctx-commit-clear-filters');
    const branchesItem = document.getElementById('ctx-branches');

    // compareRevItem/branchesItem/commitClearFilters are all static siblings
    // within the same log-mode-only #commit-context-menu template (see
    // gitLogPanel.ts's getLogHtml) - this function only ever runs when that
    // template is the one on the page (guarded by the !commitContextMenu
    // check above), so they're always present together or not at all. The
    // `if (xxxItem)` guards exist for TypeScript's strict-null-checks on
    // getElementById's return type, not because any of them can actually be
    // null here in practice - there's no realistic DOM state that isolates
    // just one.
    /* v8 ignore start */
    const showCompareRev = selectedCommitShas.length === 2;
    if (compareRevItem) {
        compareRevItem.style.display = showCompareRev ? '' : 'none';
    }
    // Without this, hiding Compare Selected Revisions (not exactly two
    // commits selected - the common case) leaves this separator sitting at
    // the very top of the menu with nothing above it - a stray-looking
    // line before Branches instead of a clean start to the menu.
    if (compareSeparator) {
        compareSeparator.style.display = showCompareRev ? '' : 'none';
    }
    if (branchesItem) {
        // -L walks a single line range's history in one shot; combining that
        // with --all or explicit branch args isn't supported, so hide it.
        branchesItem.style.display = state.lineStart ? 'none' : '';
        branchesItem.textContent = branchesMenuLabel();
    }
    hideBranchesSubmenu();
    if (commitClearFilters) {
        commitClearFilters.style.display = '';
    }
    /* v8 ignore stop */

    commitContextMenu.style.display = 'block';
    commitContextMenu.style.left = `${e.clientX}px`;
    commitContextMenu.style.top = `${e.clientY}px`;
    clampMenu(commitContextMenu);
}

function hideCommitContextMenu(): void {
    if (commitContextMenu) {
        commitContextMenu.style.display = 'none';
    }
    hideBranchesSubmenu();
}

if (document.getElementById('ctx-compare-revisions')) {
    document.getElementById('ctx-compare-revisions')!.addEventListener('click', () => {
        if (selectedCommitShas.length === 2 && commitTbody) {
            const rows = Array.from(commitTbody.querySelectorAll('tr.data-row')) as HTMLElement[];
            const idx0 = rows.findIndex(r => r.dataset.sha === selectedCommitShas[0]);
            const idx1 = rows.findIndex(r => r.dataset.sha === selectedCommitShas[1]);
            const olderSha = idx0 > idx1 ? selectedCommitShas[0] : selectedCommitShas[1];
            const newerSha = idx0 > idx1 ? selectedCommitShas[1] : selectedCommitShas[0];
            vscode.postMessage({
                type: 'compareRevisions',
                sha1: olderSha,
                sha2: newerSha,
            });
        }
        hideCommitContextMenu();
    });
}

// --- Branches submenu (log mode) ---

let allBranchesSelected = false;
let selectedBranches: string[] = [];
let branchList: string[] | null = null;

function branchesMenuLabel(): string {
    if (allBranchesSelected) return 'Branches: All';
    if (selectedBranches.length > 0) return `Branches: ${selectedBranches.length} selected`;
    return 'Branches';
}

function hideBranchesSubmenu(): void {
    const submenu = document.getElementById('branches-submenu');
    if (submenu) submenu.style.display = 'none';
}

function renderBranchesSubmenu(): void {
    const submenu = document.getElementById('branches-submenu');
    if (!submenu || !branchList) return;
    submenu.innerHTML = '';

    const allItem = document.createElement('div');
    allItem.className = 'context-menu-item';
    allItem.textContent = allBranchesSelected ? '✓ All' : 'All';
    allItem.addEventListener('click', (e) => {
        e.stopPropagation();
        allBranchesSelected = true;
        selectedBranches = [];
        updateBranchesMenu();
        reloadCommits();
        hideCommitContextMenu();
    });
    submenu.appendChild(allItem);

    const sep = document.createElement('div');
    sep.className = 'context-menu-separator';
    submenu.appendChild(sep);

    for (const branch of branchList) {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        const checked = !allBranchesSelected && selectedBranches.includes(branch);
        item.textContent = checked ? `✓ ${branch}` : branch;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            allBranchesSelected = false;
            const idx = selectedBranches.indexOf(branch);
            if (idx >= 0) selectedBranches.splice(idx, 1);
            else selectedBranches.push(branch);
            updateBranchesMenu();
            reloadCommits();
        });
        submenu.appendChild(item);
    }
}

// Re-renders both the "Branches" label on the parent menu and the submenu's
// checkmarks after a selection change, without closing either menu.
function updateBranchesMenu(): void {
    const branchesItem = document.getElementById('ctx-branches');
    if (branchesItem) branchesItem.textContent = branchesMenuLabel();
    renderBranchesSubmenu();
}

function toggleBranchesSubmenu(anchorEl: HTMLElement): void {
    const submenu = document.getElementById('branches-submenu');
    if (!submenu) return;
    if (submenu.style.display === 'block') {
        hideBranchesSubmenu();
        return;
    }
    if (branchList === null) {
        vscode.postMessage({ type: 'requestBranches' });
    } else {
        renderBranchesSubmenu();
    }
    const rect = anchorEl.getBoundingClientRect();
    submenu.style.display = 'block';
    submenu.style.left = `${rect.right}px`;
    submenu.style.top = `${rect.top}px`;
    clampMenu(submenu);
}

const ctxBranches = document.getElementById('ctx-branches');
if (ctxBranches) {
    ctxBranches.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBranchesSubmenu(ctxBranches);
    });
}

const ctxCommitClearFilters = document.getElementById('ctx-commit-clear-filters');
if (ctxCommitClearFilters) {
    ctxCommitClearFilters.addEventListener('click', () => {
        hideCommitContextMenu();
        clearAllFilters();
        resetCommitSort();
        resetFileSort();
        reloadCommits();
    });
}

const ctxCommitRefresh = document.getElementById('ctx-commit-refresh');
if (ctxCommitRefresh) {
    ctxCommitRefresh.addEventListener('click', () => {
        hideCommitContextMenu();
        reloadCommits();
    });
}

// --- Commit detail rendering (log mode) ---

function renderCommitDetail(detail: CommitDetail): void {
    if (!commitDetailPanel) return;
    commitDetailPanel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.hash)}</span>`;
    commitDetailPanel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    commitDetailPanel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    commitDetailPanel.appendChild(dateLine);

    if (detail.body) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = detail.body;
        commitDetailPanel.appendChild(bodyDiv);
    }
}

// --- Compare detail panes (compare mode) ---

function renderCompareDetail(panelId: string, detail: CommitDetail): void {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.shortHash)}</span>`;
    panel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    panel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    panel.appendChild(dateLine);

    if (detail.body) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = detail.body;
        panel.appendChild(bodyDiv);
    }
}

// --- Files list rendering (shared between both modes) ---

function dirOf(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '(root)' : filePath.substring(0, idx);
}

function baseNameOf(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.substring(idx + 1);
}

function groupKeyFor(file: FileChange, hasParentGroups: boolean): string {
    if (hasParentGroups && folderViewEnabled) return `${file.parentGroup || ''} — ${dirOf(file.path)}`;
    if (hasParentGroups) return file.parentGroup || '';
    return dirOf(file.path);
}

function renderFiles(): void {
    const hasParentGroups = allFiles.some(f => f.parentGroup);
    const useGroups = hasParentGroups || folderViewEnabled;
    let sorted: FileChange[];
    if (useGroups) {
        const groups = new Map<string, FileChange[]>();
        for (const f of allFiles) {
            const key = groupKeyFor(f, hasParentGroups);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(f);
        }
        sorted = [];
        for (const files of groups.values()) {
            sorted.push(...sortArray(files, fileSortColumn, fileSortAsc));
        }
    } else {
        sorted = sortArray(allFiles, fileSortColumn, fileSortAsc);
    }
    filesTbody.innerHTML = '';
    let currentGroup: string | null = null;
    for (const file of sorted) {
        const key = useGroups ? groupKeyFor(file, hasParentGroups) : null;
        if (useGroups && key !== currentGroup) {
            currentGroup = key;
            const groupRow = document.createElement('tr');
            groupRow.className = 'group-header-row';
            const groupCell = document.createElement('td');
            groupCell.colSpan = 4;
            groupCell.className = 'group-header';
            groupCell.textContent = currentGroup || '';
            groupRow.appendChild(groupCell);
            filesTbody.appendChild(groupRow);
        }
        const tr = document.createElement('tr');
        tr.className = 'data-row';
        tr.dataset.path = file.path;
        tr.dataset.status = file.status;
        if (file.oldPath) {
            tr.dataset.oldPath = file.oldPath;
        }

        const tdPath = document.createElement('td');
        tdPath.className = 'col-path';
        const fullDisplayPath = file.status === 'R' && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path;
        const shortDisplayPath = file.status === 'R' && file.oldPath
            ? `${baseNameOf(file.oldPath)} → ${baseNameOf(file.path)}`
            : baseNameOf(file.path);
        tdPath.textContent = folderViewEnabled ? shortDisplayPath : fullDisplayPath;
        tdPath.title = fullDisplayPath;
        tr.appendChild(tdPath);

        const tdStatus = document.createElement('td');
        tdStatus.className = `col-status status-${statusClass(file.status)}`;
        tdStatus.textContent = statusLabel(file.status);
        tr.appendChild(tdStatus);

        const tdAdd = document.createElement('td');
        tdAdd.className = 'col-additions';
        tdAdd.textContent = file.additions > 0 ? `+${file.additions}` : '0';
        tr.appendChild(tdAdd);

        const tdDel = document.createElement('td');
        tdDel.className = 'col-deletions';
        tdDel.textContent = file.deletions > 0 ? `-${file.deletions}` : '0';
        tr.appendChild(tdDel);

        tr.addEventListener('contextmenu', (e) => showFileContextMenu(e, file));
        tr.addEventListener('dblclick', () => {
            if (state.mode === 'compare') {
                vscode.postMessage({
                    type: 'compareFile',
                    filePath: file.path,
                    oldPath: file.oldPath,
                    status: file.status,
                });
            } else if (selectedCommitShas.length >= 1) {
                vscode.postMessage({
                    type: 'compareWithPrevious',
                    sha: selectedCommitShas[selectedCommitShas.length - 1],
                    filePath: file.path,
                    oldPath: file.oldPath,
                    status: file.status,
                });
            }
        });
        filesTbody.appendChild(tr);
    }
    if (hasActiveFilters()) {
        applyFilters(false);
    }
}

// --- File context menu (shared) ---

let contextFile: FileChange | null = null;

function hasActiveFilters(): boolean {
    for (const v of Object.values(filterValues)) { if (v) return true; }
    for (const v of Object.values(dateFilterFrom)) { if (v) return true; }
    for (const v of Object.values(dateFilterTo)) { if (v) return true; }
    return false;
}

function showContextMenuAt(e: MouseEvent, file: FileChange | null): void {
    e.preventDefault();
    e.stopPropagation();
    contextFile = file;
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    const compareItem = document.getElementById('ctx-compare')!;
    const compareWorkingItem = document.getElementById('ctx-compare-working')!;
    const blameItem = document.getElementById('ctx-blame')!;
    const showLogItem = document.getElementById('ctx-show-file-log')!;
    const clearFiltersItem = document.getElementById('ctx-clear-filters');
    const viewContentsItem = document.getElementById('ctx-view-file-contents');
    const canViewContents = !!file && file.status !== 'D';

    if (file) {
        showLogItem.style.display = '';
        if (state.mode === 'log') {
            compareItem.style.display = selectedCommitShas.length >= 1 ? '' : 'none';
            compareWorkingItem.style.display = selectedCommitShas.length >= 1 ? '' : 'none';
            blameItem.style.display = selectedCommitShas.length >= 1 ? '' : 'none';
            if (viewContentsItem) viewContentsItem.style.display = (selectedCommitShas.length >= 1 && canViewContents) ? '' : 'none';
        } else if (state.mode === 'compare') {
            compareItem.style.display = '';
            compareWorkingItem.style.display = '';
            blameItem.style.display = '';
            if (viewContentsItem) viewContentsItem.style.display = canViewContents ? '' : 'none';
        } else {
            // Unreachable in practice: this function is only ever invoked
            // from file-row/files-panel listeners (see call sites below),
            // and blame mode's HTML has neither, so state.mode is never
            // 'blame' here. Left in defensively rather than assuming the
            // call sites can never change.
            /* v8 ignore next 4 */
            compareItem.style.display = 'none';
            compareWorkingItem.style.display = 'none';
            blameItem.style.display = 'none';
            if (viewContentsItem) viewContentsItem.style.display = 'none';
        }
    } else {
        showLogItem.style.display = 'none';
        compareItem.style.display = 'none';
        compareWorkingItem.style.display = 'none';
        blameItem.style.display = 'none';
        if (viewContentsItem) viewContentsItem.style.display = 'none';
    }

    // ctx-copy-path/ctx-folder-view/ctx-clear-filters exist in both the log
    // and compare templates that actually reach this function (see above) -
    // same reasoning, the null case is blame-only and unreachable here.
    /* v8 ignore start */
    const copyPathItem = document.getElementById('ctx-copy-path');
    if (copyPathItem) copyPathItem.style.display = file ? '' : 'none';

    const folderViewItem = document.getElementById('ctx-folder-view');
    if (folderViewItem) {
        folderViewItem.style.display = '';
        folderViewItem.textContent = folderViewEnabled ? '✓ Folder View' : 'Folder View';
    }

    if (clearFiltersItem) {
        clearFiltersItem.style.display = '';
    }
    /* v8 ignore stop */

    const refreshItem = document.getElementById('ctx-refresh');
    const separator = contextMenu.querySelector('.context-menu-separator');
    if (refreshItem) refreshItem.style.display = 'none';
    if (separator) (separator as HTMLElement).style.display = '';

    clampMenu(contextMenu);
}

function showFileContextMenu(e: MouseEvent, file: FileChange): void {
    showContextMenuAt(e, file);
}

function hideFileContextMenu(): void {
    contextMenu.style.display = 'none';
    contextFile = null;
}

function clampMenu(menu: HTMLElement): void {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height}px`;
    }
}

// Resolves which commit's version of the selected file the file list is showing
function resolveFileListSha(): string | null {
    return fileListCommitSha
        || (selectedCommitShas.length >= 1 ? selectedCommitShas[selectedCommitShas.length - 1] : null)
        || state.sha2
        || null;
}

// Compare with Previous
document.getElementById('ctx-compare')!.addEventListener('click', () => {
    if (!contextFile) { hideFileContextMenu(); return; }
    const sha = resolveFileListSha();
    if (!sha) { hideFileContextMenu(); return; }

    // Find the previous commit from the displayed list
    let previousSha: string | undefined;
    if (commitTbody) {
        const rows = Array.from(
            commitTbody.querySelectorAll('tr.data-row:not(.filtered-out)')
        ) as HTMLElement[];
        const idx = rows.findIndex(r => r.dataset.sha === sha);
        if (idx >= 0 && idx + 1 < rows.length) {
            previousSha = rows[idx + 1].dataset.sha;
        }
    }

    vscode.postMessage({
        type: 'compareWithPrevious',
        sha,
        previousSha,
        filePath: contextFile.path,
        oldPath: contextFile.oldPath,
        status: contextFile.status,
    });
    hideFileContextMenu();
});

// Compare with Working Tree
document.getElementById('ctx-compare-working')!.addEventListener('click', () => {
    if (!contextFile) { hideFileContextMenu(); return; }
    const sha = resolveFileListSha();
    if (!sha) { hideFileContextMenu(); return; }

    vscode.postMessage({
        type: 'compareWithWorkingTree',
        sha,
        filePath: contextFile.path,
        oldPath: contextFile.oldPath,
        status: contextFile.status,
    });
    hideFileContextMenu();
});

// Blame
document.getElementById('ctx-blame')!.addEventListener('click', () => {
    if (!contextFile) { hideFileContextMenu(); return; }
    const sha = resolveFileListSha();
    if (sha) {
        vscode.postMessage({
            type: 'blame',
            sha,
            filePath: contextFile.path,
        });
    }
    hideFileContextMenu();
});

// View File Contents
const ctxViewFileContents = document.getElementById('ctx-view-file-contents');
if (ctxViewFileContents) {
    ctxViewFileContents.addEventListener('click', () => {
        if (!contextFile) { hideFileContextMenu(); return; }
        const sha = resolveFileListSha();
        if (sha) {
            vscode.postMessage({
                type: 'viewFileContents',
                sha,
                filePath: contextFile.path,
            });
        }
        hideFileContextMenu();
    });
}

// Folder View toggle
const ctxFolderView = document.getElementById('ctx-folder-view');
if (ctxFolderView) {
    ctxFolderView.addEventListener('click', () => {
        folderViewEnabled = !folderViewEnabled;
        hideFileContextMenu();
        renderFiles();
    });
}

// Copy path
const ctxCopyPath = document.getElementById('ctx-copy-path');
if (ctxCopyPath) {
    ctxCopyPath.addEventListener('click', () => {
        if (contextFile) {
            navigator.clipboard.writeText(contextFile.path);
        }
        hideFileContextMenu();
    });
}

// Both modes: Show file log
document.getElementById('ctx-show-file-log')!.addEventListener('click', () => {
    if (contextFile) {
        vscode.postMessage({
            type: 'showFileLog',
            filePath: contextFile.path,
        });
    }
    hideFileContextMenu();
});

function clearAllFilters(): void {
    Object.keys(filterValues).forEach(k => delete filterValues[k]);
    Object.keys(dateFilterFrom).forEach(k => delete dateFilterFrom[k]);
    Object.keys(dateFilterTo).forEach(k => delete dateFilterTo[k]);
    document.querySelectorAll<HTMLInputElement>('.filter-input').forEach(input => {
        input.value = '';
    });
}

function resetCommitSort(): void {
    commitSortColumn = null;
    commitSortAsc = false;
    document.getElementById('commit-table')?.querySelectorAll('th .sort-arrow')
        .forEach(el => { el.textContent = ''; });
}

function resetFileSort(): void {
    fileSortColumn = 'path';
    fileSortAsc = true;
    updateSortArrows('files-table', 'path', true);
}

const ctxRefresh = document.getElementById('ctx-refresh');
if (ctxRefresh) {
    ctxRefresh.addEventListener('click', () => {
        hideFileContextMenu();
        if (state.mode === 'log') {
            reloadCommits();
        } else if (state.mode === 'compare') {
            vscode.postMessage({ type: 'requestCompareFiles' });
        }
    });
}

const ctxClearFilters = document.getElementById('ctx-clear-filters');
if (ctxClearFilters) {
    ctxClearFilters.addEventListener('click', () => {
        hideFileContextMenu();
        clearAllFilters();
        resetCommitSort();
        resetFileSort();
        if (state.mode === 'log') {
            reloadCommits();
        } else if (state.mode === 'compare') {
            renderFiles();
        }
    });
}

// Panel-level right-click for Refresh/Clear Filters
const commitListPanel = document.getElementById('commit-list-panel');
if (commitListPanel) {
    commitListPanel.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('tr.data-row')) return;
        showCommitContextMenu(e as MouseEvent);
    });
}

const filesPanel = document.getElementById('files-changed-panel');
if (filesPanel) {
    filesPanel.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('tr.data-row')) return;
        showContextMenuAt(e as MouseEvent, null);
    });
}

document.addEventListener('click', () => {
    hideFileContextMenu();
    hideCommitContextMenu();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideFileContextMenu();
        hideCommitContextMenu();
    }
});

// --- Column sorting handlers ---

document.querySelectorAll('#commit-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
        if (columnResizing) return;
        const col = (th as HTMLElement).dataset.col as keyof Commit;
        if (commitSortColumn === col) {
            commitSortAsc = !commitSortAsc;
        } else {
            commitSortColumn = col;
            commitSortAsc = true;
        }
        updateSortArrows('commit-table', col, commitSortAsc);
        renderCommits();
    });
});

document.querySelectorAll('#files-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
        if (columnResizing) return;
        const col = (th as HTMLElement).dataset.col as keyof FileChange;
        if (fileSortColumn === col) {
            fileSortAsc = !fileSortAsc;
        } else {
            fileSortColumn = col;
            fileSortAsc = true;
        }
        updateSortArrows('files-table', col, fileSortAsc);
        renderFiles();
    });
});

// --- Infinite scroll (log mode only) ---

if (loadMore) {
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
            requestMoreCommits();
        }
    });
    observer.observe(loadMore);
}

function autoLoadIfNeeded(): void {
    if (!hasMore || loading || !commitTbody || !hasActiveFilters()) return;
    const total = commitTbody.querySelectorAll('tr.data-row').length;
    const hidden = commitTbody.querySelectorAll('tr.data-row.filtered-out').length;
    const visible = total - hidden;
    if (visible < 20) {
        requestMoreCommits();
    }
}

const PAGE_SIZE = state.pageSize || 100;

function requestMoreCommits(): void {
    loading = true;
    if (loadMore) loadMore.textContent = 'Loading...';
    const msg: Record<string, unknown> = {
        type: 'requestCommits',
        offset: allCommits.length,
        count: PAGE_SIZE,
    };
    if (allBranchesSelected) {
        msg.branches = 'all';
    } else if (selectedBranches.length > 0) {
        msg.branches = selectedBranches;
    }
    if (dateFilterFrom['authorDate']) {
        msg.after = dateFilterFrom['authorDate'] + 'T00:00:00';
    }
    if (dateFilterTo['authorDate']) {
        msg.before = dateFilterTo['authorDate'] + 'T23:59:59';
    }
    vscode.postMessage(msg);
}

function reloadCommits(): void {
    allCommits = [];
    selectedCommitShas.length = 0;
    hasMore = true;
    if (commitTbody) commitTbody.innerHTML = '';
    if (commitDetailPanel) commitDetailPanel.innerHTML = '<div class="empty-state">Select a commit to view details</div>';
    if (filesTbody) filesTbody.innerHTML = '';
    if (loadMore) loadMore.style.display = '';
    requestMoreCommits();
}

// --- Panel resizing ---

document.querySelectorAll('.resizer').forEach(resizer => {
    let startY = 0;
    let startRows: number[] = [];

    const el = resizer as HTMLElement;
    const app = document.getElementById('app')!;

    el.addEventListener('mousedown', (e: Event) => {
        const me = e as MouseEvent;
        startY = me.clientY;
        const computed = getComputedStyle(app);
        startRows = computed.gridTemplateRows.split(' ').map(v => parseFloat(v));
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });

    function onMouseMove(e: MouseEvent): void {
        const resizerIndex = Array.from(app.children).indexOf(el);
        const panelAbove = resizerIndex - 1;
        const panelBelow = resizerIndex + 1;
        const delta = e.clientY - startY;
        const newRows = [...startRows];
        newRows[panelAbove] = Math.max(50, startRows[panelAbove] + delta);
        newRows[panelBelow] = Math.max(50, startRows[panelBelow] - delta);
        app.style.gridTemplateRows = newRows.map(v => `${v}px`).join(' ');
    }

    function onMouseUp(): void {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
});

// --- Column (vertical) panel resizing ---

document.querySelectorAll('.resizer-col').forEach(resizer => {
    let startX = 0;
    let startCols: number[] = [];

    const el = resizer as HTMLElement;
    const parent = el.parentElement!;

    el.addEventListener('mousedown', (e: Event) => {
        const me = e as MouseEvent;
        startX = me.clientX;
        const computed = getComputedStyle(parent);
        startCols = computed.gridTemplateColumns.split(' ').map(v => parseFloat(v));
        document.addEventListener('mousemove', onColMove);
        document.addEventListener('mouseup', onColUp);
        e.preventDefault();
    });

    function onColMove(e: MouseEvent): void {
        const resizerIndex = Array.from(parent.children).indexOf(el);
        const panelLeft = resizerIndex - 1;
        const panelRight = resizerIndex + 1;
        const delta = e.clientX - startX;
        const newCols = [...startCols];
        newCols[panelLeft] = Math.max(50, startCols[panelLeft] + delta);
        newCols[panelRight] = Math.max(50, startCols[panelRight] - delta);
        parent.style.gridTemplateColumns = newCols.map(v => `${v}px`).join(' ');
    }

    function onColUp(): void {
        document.removeEventListener('mousemove', onColMove);
        document.removeEventListener('mouseup', onColUp);
    }
});

// --- Column resizing ---

let columnResizing = false;

function initColumnResizers(): void {
    document.querySelectorAll('th[data-col]').forEach(th => {
        const resizer = document.createElement('div');
        resizer.className = 'col-resizer';
        th.appendChild(resizer);

        let startX = 0;
        let startWidth = 0;

        resizer.addEventListener('mousedown', (e: Event) => {
            const me = e as MouseEvent;
            me.stopPropagation();
            me.preventDefault();
            columnResizing = true;
            startX = me.clientX;
            startWidth = (th as HTMLElement).offsetWidth;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        resizer.addEventListener('dblclick', (e: Event) => {
            e.stopPropagation();
            autoExpandColumn(th as HTMLElement);
        });

        function onMouseMove(e: MouseEvent): void {
            const delta = e.clientX - startX;
            const newWidth = Math.max(40, startWidth + delta);
            (th as HTMLElement).style.width = `${newWidth}px`;
        }

        function onMouseUp(): void {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            setTimeout(() => { columnResizing = false; }, 0);
        }
    });
}

function autoExpandColumn(th: HTMLElement): void {
    const table = th.closest('table');
    if (!table) return;
    const colIndex = Array.from(th.parentElement!.children).indexOf(th);
    let maxWidth = th.scrollWidth;
    table.querySelectorAll('tbody tr').forEach(row => {
        const cell = row.children[colIndex] as HTMLElement;
        if (cell) {
            maxWidth = Math.max(maxWidth, cell.scrollWidth + 16);
        }
    });
    th.style.width = `${Math.min(maxWidth, 600)}px`;
}

initColumnResizers();

// --- Column filtering ---

const filterValues: Record<string, string> = {};
const dateFilterFrom: Record<string, string> = {};
const dateFilterTo: Record<string, string> = {};
const dateColumns = ['authorDate'];
const noFilterColumns = ['additions', 'deletions'];

function initColumnFilters(): void {
    document.querySelectorAll('thead').forEach(thead => {
        const headerRow = thead.querySelector('tr');
        if (!headerRow) return;
        const filterRow = document.createElement('tr');
        filterRow.className = 'filter-row';
        headerRow.querySelectorAll('th').forEach(th => {
            const td = document.createElement('td');
            td.className = 'filter-cell';
            const col = (th as HTMLElement).dataset.col || '';
            if (col && noFilterColumns.includes(col)) {
                // no filter for these columns
            } else if (col && dateColumns.includes(col)) {
                const wrapper = document.createElement('div');
                wrapper.className = 'date-filter-wrapper';
                const fromInput = document.createElement('input');
                fromInput.type = 'date';
                fromInput.className = 'filter-input filter-date';
                fromInput.title = 'From date';
                fromInput.addEventListener('input', () => {
                    dateFilterFrom[col] = fromInput.value;
                    if (state.mode === 'log') reloadCommits();
                    else applyFilters();
                });
                fromInput.addEventListener('click', (e) => e.stopPropagation());
                const toInput = document.createElement('input');
                toInput.type = 'date';
                toInput.className = 'filter-input filter-date';
                toInput.title = 'To date';
                toInput.addEventListener('input', () => {
                    dateFilterTo[col] = toInput.value;
                    if (state.mode === 'log') reloadCommits();
                    else applyFilters();
                });
                toInput.addEventListener('click', (e) => e.stopPropagation());
                wrapper.appendChild(fromInput);
                wrapper.appendChild(toInput);
                td.appendChild(wrapper);
            } else if (col) {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'filter-input';
                input.placeholder = 'Filter...';
                input.dataset.col = col;
                input.addEventListener('input', () => {
                    filterValues[col] = input.value.toLowerCase();
                    const isCommitFilter = input.closest('#commit-table') !== null;
                    applyFilters(isCommitFilter);
                    if (isCommitFilter) autoLoadIfNeeded();
                });
                input.addEventListener('click', (e) => e.stopPropagation());
                td.appendChild(input);
            }
            filterRow.appendChild(td);
        });
        thead.appendChild(filterRow);
    });
}

function applyFilters(autoSelect: boolean = true): void {
    document.querySelectorAll('tbody').forEach(tbody => {
        const id = tbody.id;
        if (id === 'blame-gutter-tbody' || id === 'blame-code-tbody') return;
        tbody.querySelectorAll('tr.data-row').forEach(row => {
            const cells = row.querySelectorAll('td');
            const thead = row.closest('table')?.querySelector('thead tr');
            if (!thead) return;
            let visible = true;
            // Every <th> (not just ones with data-col) - `i` has to stay
            // aligned with `cells`' real DOM position for cells[i] below to
            // read the right column. The graph column has no data-col (it's
            // not filterable) but is still a real cell each row has, so
            // querying th[data-col] here would skip it and shift every
            // following index left by one - filtering the wrong columns
            // against each other's values.
            const ths = thead.querySelectorAll('th');
            ths.forEach((th, i) => {
                const col = (th as HTMLElement).dataset.col || '';
                if (!col) {
                    // No filter applies to this column (graph, or any
                    // future non-data column) - never hides a row on its
                    // own.
                    return;
                }
                if (dateColumns.includes(col)) {
                    // In log mode, date filtering is handled server-side via --since/--until.
                    // dateColumns is just ['authorDate'], and that column only ever exists on
                    // the commit table, which only ever exists in log mode - so this branch
                    // is unreachable with the current HTML templates. Left in as a guard
                    // against future non-log tables gaining a date column, rather than
                    // deleted, but that also means it can't be exercised by any real test.
                    /* v8 ignore next 12 */
                    if (state.mode !== 'log') {
                        const rawDate = (cells[i] as HTMLElement)?.dataset.rawDate || '';
                        const cellDate = rawDate ? new Date(rawDate) : null;
                        if (!cellDate || isNaN(cellDate.getTime())) return;
                        const from = dateFilterFrom[col];
                        const to = dateFilterTo[col];
                        if (from) {
                            const fromDate = new Date(from + 'T00:00:00');
                            if (cellDate < fromDate) visible = false;
                        }
                        if (to) {
                            const toDate = new Date(to + 'T23:59:59');
                            if (cellDate > toDate) visible = false;
                        }
                    }
                } else {
                    const filter = filterValues[col];
                    if (filter && cells[i]) {
                        const text = (cells[i] as HTMLElement).textContent?.toLowerCase() || '';
                        if (!text.includes(filter)) {
                            visible = false;
                        }
                    }
                }
            });
            row.classList.toggle('filtered-out', !visible);
        });
    });

    if (autoSelect && commitTbody) {
        selectedCommitShas.length = 0;
        selectFirstVisibleCommit();
    }

    // renderCommits() calls this itself when there's an active filter to
    // reapply, so it already re-renders the graph afterward in that path -
    // but applyFilters() also runs on its own on every filter keystroke
    // (see initColumnFilters()'s text-input listener), which never goes
    // through renderCommits() at all. Without this, typing into a filter
    // would leave the graph showing the previous filtered-out state until
    // the next full re-render.
    if (state.mode === 'log') {
        const sorted = commitSortColumn
            ? sortArray(allCommits, commitSortColumn, commitSortAsc)
            : allCommits;
        renderCommitGraph(sorted);
    }
}

initColumnFilters();

// --- Blame mode rendering ---

interface BlameLineData {
    sha: string;
    shortSha: string;
    author: string;
    authorEmail: string;
    timestamp: number;
    date: string;
    summary: string;
    lineNo: number;
    content: string;
}

let blameCommits: Record<string, CommitDetail> = {};
let blameLockedSha: string | null = null;

function renderBlame(lines: BlameLineData[], commits: Record<string, CommitDetail>): void {
    blameCommits = commits;
    const gutterTbody = document.getElementById('blame-gutter-tbody') as HTMLTableSectionElement;
    const codeTbody = document.getElementById('blame-code-tbody') as HTMLTableSectionElement;
    if (!gutterTbody || !codeTbody) return;

    const shaColors = new Map<string, string>();
    const uniqueShas = [...new Set(lines.map(l => l.sha))];
    for (let i = 0; i < uniqueShas.length; i++) {
        const hue = (i * 47) % 360;
        shaColors.set(uniqueShas[i], `hsla(${hue}, 40%, 50%, 0.12)`);
    }

    let prevSha = '';
    for (const line of lines) {
        const isNewBlock = line.sha !== prevSha;
        const bgColor = shaColors.get(line.sha) || 'transparent';

        const gutterRow = document.createElement('tr');
        gutterRow.className = 'blame-row';
        gutterRow.dataset.sha = line.sha;
        gutterRow.style.backgroundColor = bgColor;

        const tdSha = document.createElement('td');
        tdSha.className = 'blame-sha';
        tdSha.textContent = isNewBlock ? line.shortSha : '';
        gutterRow.appendChild(tdSha);

        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'blame-author';
        tdAuthor.textContent = isNewBlock ? line.author : '';
        gutterRow.appendChild(tdAuthor);

        const tdDate = document.createElement('td');
        tdDate.className = 'blame-date';
        tdDate.textContent = isNewBlock ? formatTimeAgo(line.timestamp) : '';
        gutterRow.appendChild(tdDate);

        gutterRow.addEventListener('mouseenter', () => onBlameHover(line.sha));
        gutterRow.addEventListener('click', () => onBlameClick(line.sha));
        gutterTbody.appendChild(gutterRow);

        const codeRow = document.createElement('tr');
        codeRow.className = 'blame-row';
        codeRow.dataset.sha = line.sha;
        codeRow.style.backgroundColor = bgColor;

        const tdLineNo = document.createElement('td');
        tdLineNo.className = 'blame-line-no';
        tdLineNo.textContent = String(line.lineNo);
        codeRow.appendChild(tdLineNo);

        const tdCode = document.createElement('td');
        tdCode.className = 'blame-code';
        tdCode.textContent = line.content;
        codeRow.appendChild(tdCode);

        codeRow.addEventListener('mouseenter', () => onBlameHover(line.sha));
        codeRow.addEventListener('click', () => onBlameClick(line.sha));
        codeTbody.appendChild(codeRow);

        prevSha = line.sha;
    }

    // Sync scroll between gutter and code
    const gutterPanel = document.getElementById('blame-gutter-panel');
    const codePanel = document.getElementById('blame-code-panel');
    if (gutterPanel && codePanel) {
        let syncing = false;
        gutterPanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            codePanel.scrollTop = gutterPanel.scrollTop;
            syncing = false;
        });
        codePanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            gutterPanel.scrollTop = codePanel.scrollTop;
            syncing = false;
        });
    }
}

function onBlameHover(sha: string): void {
    if (blameLockedSha) return;
    highlightBlameSha(sha);
    showBlameCommitInfo(sha);
}

function onBlameClick(sha: string): void {
    if (blameLockedSha === sha) {
        blameLockedSha = null;
        highlightBlameSha('');
        const infoPanel = document.getElementById('blame-commit-info');
        if (infoPanel) {
            infoPanel.innerHTML = '<div class="empty-state">Hover over a revision to see commit details</div>';
        }
    } else {
        blameLockedSha = sha;
        highlightBlameSha(sha);
        showBlameCommitInfo(sha);
    }
}

function highlightBlameSha(sha: string): void {
    document.querySelectorAll('.blame-row').forEach(row => {
        const el = row as HTMLElement;
        if (sha && el.dataset.sha === sha) {
            el.classList.add('blame-highlight');
        } else {
            el.classList.remove('blame-highlight');
        }
    });
}

function showBlameCommitInfo(sha: string): void {
    const infoPanel = document.getElementById('blame-commit-info');
    if (!infoPanel) return;
    const detail = blameCommits[sha];
    if (!detail) return;

    infoPanel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.hash)}</span>`;
    infoPanel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    infoPanel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    infoPanel.appendChild(dateLine);

    const subjectLine = document.createElement('div');
    subjectLine.innerHTML = `<span class="detail-label">Subject: </span>${escapeHtml(detail.body.split('\n')[0])}`;
    infoPanel.appendChild(subjectLine);

    const bodyText = detail.body.split('\n').slice(1).join('\n').trim();
    if (bodyText) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = bodyText;
        infoPanel.appendChild(bodyDiv);
    }
}

// --- Message handling ---

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'commitsLoaded': {
            const newCommits: Commit[] = msg.commits;
            allCommits = allCommits.concat(newCommits);
            if (msg.graphEdges) graphEdges = msg.graphEdges;
            hasMore = msg.hasMore;
            loading = false;
            renderCommits();
            if (!hasMore && loadMore) {
                loadMore.style.display = 'none';
            } else if (loadMore) {
                loadMore.textContent = 'Scroll for more...';
            }
            if (allCommits.length > 0 && selectedCommitShas.length === 0) {
                selectFirstVisibleCommit();
            } else if (allCommits.length === 0) {
                clearDetailPanels();
            }
            autoLoadIfNeeded();
            break;
        }
        case 'commitDetailsLoaded': {
            if (msg.detail.hash !== latestRequestedDetailSha) {
                break;
            }
            renderCommitDetail(msg.detail);
            fileListCommitSha = msg.detail.hash;
            allFiles = msg.files;
            fileSortColumn = 'path';
            fileSortAsc = true;
            updateSortArrows('files-table', 'path', true);
            renderFiles();
            break;
        }
        case 'compareFilesLoaded': {
            if (msg.detail1) renderCompareDetail('compare-detail-1', msg.detail1);
            if (msg.detail2) renderCompareDetail('compare-detail-2', msg.detail2);
            allFiles = msg.files;
            fileSortColumn = 'path';
            fileSortAsc = true;
            updateSortArrows('files-table', 'path', true);
            renderFiles();
            break;
        }
        case 'blameDataLoaded': {
            renderBlame(msg.lines, msg.commits);
            break;
        }
        case 'branchesLoaded': {
            branchList = msg.branches;
            renderBranchesSubmenu();
            break;
        }
        case 'commitRefsLoaded': {
            inFlightRefsRequests.delete(msg.sha);
            commitRefsCache.set(msg.sha, { branches: msg.branches, tags: msg.tags });
            // Only touch the visible tooltip if it's still showing (or
            // still pending) for this exact commit - the user may have
            // moved to a different dot, or away entirely, by the time this
            // round trip comes back.
            if (currentTooltipSha === msg.sha) {
                renderGraphTooltipContent(msg.sha);
            }
            break;
        }
        case 'error': {
            if (commitDetailPanel) {
                commitDetailPanel.innerHTML = `<div class="empty-state">${escapeHtml(msg.message)}</div>`;
            }
            break;
        }
    }
});

// --- Init ---
if (state.mode === 'log') {
    requestMoreCommits();
} else if (state.mode === 'compare') {
    vscode.postMessage({ type: 'requestCompareFiles' });
} else if (state.mode === 'blame') {
    vscode.postMessage({ type: 'requestBlameData' });
}
