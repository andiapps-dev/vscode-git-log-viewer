// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadWebview, sendFromExtension, triggerLoadMoreIntersection } from './harness';

function commit(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        hash: 'hash-' + Math.random().toString(36).slice(2),
        shortHash: 'abc1234',
        subject: 'a commit',
        authorName: 'Alice',
        authorDate: '2024-01-01T00:00:00-05:00',
        refs: '',
        parentHashes: [],
        ...overrides,
    };
}

function file(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        path: 'src/foo.ts',
        status: 'M',
        additions: 1,
        deletions: 1,
        ...overrides,
    };
}

function rightClick(el: Element): void {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }));
}

describe('log mode: initial load + rendering', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('requests commits on load and renders the response', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 0, count: 100 });

        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', subject: 'first' }), commit({ hash: 'h2', subject: 'second' })],
            hasMore: false,
        });

        const rows = document.querySelectorAll('#commit-tbody tr.data-row');
        expect(rows.length).toBe(2);
        expect(document.getElementById('load-more')?.style.display).toBe('none');
    });

    it('shows "Scroll for more..." when hasMore is true', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: true });
        expect(document.getElementById('load-more')?.textContent).toBe('Scroll for more...');
    });

    it('shows empty state when there are no commits', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [], hasMore: false });
        const panel = document.getElementById('commit-detail-panel');
        expect(panel?.textContent).toContain('No commits to display');
    });

    it('auto-selects the first commit and requests its details', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
            hasMore: false,
        });

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommitDetails', sha: 'h1' });
        const firstRow = document.querySelector('#commit-tbody tr[data-sha="h1"]');
        expect(firstRow?.classList.contains('selected')).toBe(true);
    });

    it('renders ref badges with the right classes', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', refs: 'HEAD -> main, tag: v1.0, origin/main' })],
            hasMore: false,
        });

        const badges = document.querySelectorAll('#commit-tbody .ref-pill');
        expect(badges.length).toBe(3);
        expect(document.querySelector('.ref-head')?.textContent).toBe('HEAD -> main');
        expect(document.querySelector('.ref-tag')?.textContent).toBe('v1.0');
        expect(document.querySelector('.ref-branch')?.textContent).toBe('origin/main');
    });
});

describe('log mode: commit detail + file list', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('renders commit detail fields', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'Alice', authorEmail: 'a@x.com', authorDate: '2024-01-01T00:00:00-05:00', body: 'Fix the thing\n\nmore detail' },
            files: [],
        });

        const panel = document.getElementById('commit-detail-panel')!;
        expect(panel.textContent).toContain('Alice');
        expect(panel.textContent).toContain('a@x.com');
        expect(panel.querySelector('.detail-body')?.textContent).toContain('more detail');
    });

    it('drops a stale commitDetailsLoaded response for a superseded selection', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
            hasMore: false,
        });
        // h1 auto-selected -> requested. Now select h2, superseding the h1 request.
        const row2 = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        click(row2);

        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'Stale', authorEmail: 'x', authorDate: '2024-01-01', body: '' },
            files: [],
        });

        const panel = document.getElementById('commit-detail-panel')!;
        expect(panel.textContent).not.toContain('Stale');
    });

    it('renders a rename as "old -> new" and applies status class', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'new.ts', oldPath: 'old.ts', status: 'R' })],
        });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        expect(row.querySelector('.col-path')?.textContent).toBe('old.ts → new.ts');
        expect(row.querySelector('.col-status')?.className).toContain('status-');
    });

    it('groups files by parentGroup for merge commits', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [
                file({ path: 'a.ts', parentGroup: 'Parent 1' }),
                file({ path: 'b.ts', parentGroup: 'Parent 2' }),
            ],
        });

        const groupHeaders = document.querySelectorAll('#files-tbody .group-header-row');
        expect(groupHeaders.length).toBe(2);
    });

    it('resets file sort to path-ascending on every new file list', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'b.ts' }), file({ path: 'a.ts' })],
        });

        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(td => td.textContent);
        expect(paths).toEqual(['a.ts', 'b.ts']);
        const arrow = document.querySelector('#files-table th[data-col="path"] .sort-arrow');
        expect(arrow?.textContent).toBe(' ▲');
    });
});

describe('log mode: sorting', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('sorts the commit table by clicking a column header, toggling direction on repeat clicks', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                commit({ hash: 'h1', authorName: 'Bob' }),
                commit({ hash: 'h2', authorName: 'Alice' }),
            ],
            hasMore: false,
        });

        const authorTh = document.querySelector('#commit-table th[data-col="authorName"]')!;
        click(authorTh);
        let authors = Array.from(document.querySelectorAll('#commit-tbody .col-author')).map(td => td.textContent);
        expect(authors).toEqual(['Alice', 'Bob']);
        expect(authorTh.querySelector('.sort-arrow')?.textContent).toBe(' ▲');

        click(authorTh);
        authors = Array.from(document.querySelectorAll('#commit-tbody .col-author')).map(td => td.textContent);
        expect(authors).toEqual(['Bob', 'Alice']);
        expect(authorTh.querySelector('.sort-arrow')?.textContent).toBe(' ▼');
    });

    it('sorts the files table by clicking a column header', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'a.ts', additions: 5 }), file({ path: 'b.ts', additions: 1 })],
        });

        const addTh = document.querySelector('#files-table th[data-col="additions"]')!;
        click(addTh);
        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(td => td.textContent);
        expect(paths).toEqual(['b.ts', 'a.ts']);
    });
});

describe('log mode: filtering', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('hides non-matching rows when typing a text filter', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', subject: 'fix bug' }), commit({ hash: 'h2', subject: 'add feature' })],
            hasMore: false,
        });

        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        filterInput.value = 'fix';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        const row1 = document.querySelector('#commit-tbody tr[data-sha="h1"]')!;
        const row2 = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        expect(row1.classList.contains('filtered-out')).toBe(false);
        expect(row2.classList.contains('filtered-out')).toBe(true);
    });

    it('clicking into a filter input does not bubble up and dismiss an open context menu', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('block');

        const textFilter = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        click(textFilter);
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('block');

        const dateInputs = document.querySelectorAll<HTMLInputElement>('#commit-table input[type="date"]');
        const fromInput = dateInputs[0];
        const toInput = dateInputs[1];
        click(fromInput);
        click(toInput);
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('block');
    });

    it('reloads commits with server-side date range when a date filter changes', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        api.postMessage.mockClear();

        const fromInput = document.querySelectorAll<HTMLInputElement>('#commit-table input[type="date"]')[0];
        fromInput.value = '2024-01-01';
        fromInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits',
            offset: 0,
            after: '2024-01-01T00:00:00',
        }));
    });
});

describe('log mode: commit graph', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('draws a connecting line between a commit and its parent, and sizes the column to the lane count', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                commit({ hash: 'h1', parentHashes: ['h2'] }),
                commit({ hash: 'h2', parentHashes: [] }),
            ],
            hasMore: false,
        });

        expect(document.getElementById('commit-table')?.classList.contains('graph-hidden')).toBe(false);

        const graphHeader = document.querySelector<HTMLElement>('#commit-table th.col-graph')!;
        expect(graphHeader.style.width).toBe('14px'); // one lane wide

        const row1Svg = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg')!;
        const row2Svg = document.querySelector('#commit-tbody tr[data-sha="h2"] td.col-graph svg')!;
        // h1 (first row, nothing above it) draws only its own lower-half
        // curve down toward h2; h2 draws only the upper-half curve coming
        // in from h1 (it's a root itself, no lower half of its own).
        expect(row1Svg.querySelectorAll('path')).toHaveLength(1);
        expect(row2Svg.querySelectorAll('path')).toHaveLength(1);
        // Every row gets its own node dot regardless of segments.
        expect(row1Svg.querySelectorAll('circle')).toHaveLength(1);
        expect(row2Svg.querySelectorAll('circle')).toHaveLength(1);
    });

    describe('node dot hover tooltip', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('waits out the hover delay before requesting refs, then shows them once loaded', async () => {
            const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 50, clientY: 60 }));

            const tooltip = document.getElementById('commit-graph-tooltip')!;
            // Still hidden and no request sent yet - the hover delay hasn't
            // elapsed, so a mouse merely passing over the dot never fires a
            // git call at all.
            expect(tooltip.style.display).toBe('none');
            expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestCommitRefs' }));

            vi.advanceTimersByTime(150);
            expect(tooltip.style.display).toBe('block');
            expect(tooltip.textContent).toContain('Loading');
            expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommitRefs', sha: 'h1' });
            expect(tooltip.style.left).toBe('62px'); // clientX + 12
            expect(tooltip.style.top).toBe('72px'); // clientY + 12

            sendFromExtension({ type: 'commitRefsLoaded', sha: 'h1', branches: ['main', 'feature/x'], tags: ['v1.2.0'] });
            // Real ref-pill badges (same classes as the Message column's
            // own ref decorations), not a plain comma-joined string.
            const branchPills = tooltip.querySelectorAll('.ref-pill.ref-branch');
            expect(Array.from(branchPills).map(p => p.textContent)).toEqual(['main', 'feature/x']);
            const tagPills = tooltip.querySelectorAll('.ref-pill.ref-tag');
            expect(Array.from(tagPills).map(p => p.textContent)).toEqual(['v1.2.0']);
        });

        it('shows parent hashes immediately, before the branches/tags request even resolves', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({
                type: 'commitsLoaded',
                commits: [commit({ hash: 'h1', parentHashes: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })],
                hasMore: false,
            });

            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);

            const tooltip = document.getElementById('commit-graph-tooltip')!;
            // Already available client-side (no round trip needed) - shows
            // up front, alongside "Loading…" for the part that does need one.
            expect(tooltip.textContent).toContain('Parent:');
            expect(tooltip.textContent).toContain('aaaaaaa'); // 7-char short form
            expect(tooltip.textContent).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            expect(tooltip.textContent).toContain('Loading');
        });

        it('labels a merge commit\'s multiple parents as plural', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({
                type: 'commitsLoaded',
                commits: [commit({ hash: 'merge', parentHashes: ['p1111111111111111111111111111111111111', 'p2222222222222222222222222222222222222'] })],
                hasMore: false,
            });

            const dot = document.querySelector('#commit-tbody tr[data-sha="merge"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);

            const tooltip = document.getElementById('commit-graph-tooltip')!;
            expect(tooltip.textContent).toContain('Parents:');
            expect(tooltip.textContent).toContain('p111111, p222222');
        });

        it('omits the parent row entirely for a root commit', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({
                type: 'commitsLoaded',
                commits: [commit({ hash: 'root', parentHashes: [] })],
                hasMore: false,
            });

            const dot = document.querySelector('#commit-tbody tr[data-sha="root"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);

            expect(document.getElementById('commit-graph-tooltip')?.textContent).not.toContain('Parent');
        });

        it('cancels the pending request if the mouse leaves before the hover delay elapses', async () => {
            const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            vi.advanceTimersByTime(150);

            expect(document.getElementById('commit-graph-tooltip')?.style.display).toBe('none');
            expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestCommitRefs' }));
        });

        it('hides the tooltip on mouseout after it has been shown', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);
            expect(document.getElementById('commit-graph-tooltip')?.style.display).toBe('block');

            dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            expect(document.getElementById('commit-graph-tooltip')?.style.display).toBe('none');
        });

        it('shows "not on any branch or tag" when a commit is reachable from neither', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);
            sendFromExtension({ type: 'commitRefsLoaded', sha: 'h1', branches: [], tags: [] });

            expect(document.getElementById('commit-graph-tooltip')?.textContent).toContain('Not on any current branch or tag');
        });

        it('reuses a cached result on a second hover instead of requesting it again', async () => {
            const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
            const dot = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;

            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);
            sendFromExtension({ type: 'commitRefsLoaded', sha: 'h1', branches: ['main'], tags: [] });
            dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            api.postMessage.mockClear();

            dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);
            // Shows immediately from cache, not a "Loading…" placeholder,
            // and never re-requests data it already has.
            expect(document.getElementById('commit-graph-tooltip')?.textContent).toContain('main');
            expect(api.postMessage).not.toHaveBeenCalled();
        });

        it('ignores a commitRefsLoaded response for a commit that is no longer the one hovered', async () => {
            await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
            sendFromExtension({
                type: 'commitsLoaded',
                commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
                hasMore: false,
            });
            const dot1 = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg circle')!;
            const dot2 = document.querySelector('#commit-tbody tr[data-sha="h2"] td.col-graph svg circle')!;

            dot1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);
            dot1.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            dot2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            vi.advanceTimersByTime(150);

            // h1's request resolves after focus has already moved to h2 -
            // must not clobber what's now on screen.
            sendFromExtension({ type: 'commitRefsLoaded', sha: 'h1', branches: ['stale'], tags: [] });
            expect(document.getElementById('commit-graph-tooltip')?.textContent).not.toContain('stale');
        });
    });

    it('opens a second lane and draws two lines for a merge commit', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                commit({ hash: 'merge', parentHashes: ['p1', 'p2'] }),
                commit({ hash: 'p1', parentHashes: [] }),
                commit({ hash: 'p2', parentHashes: [] }),
            ],
            hasMore: false,
        });

        const mergeSvg = document.querySelector('#commit-tbody tr[data-sha="merge"] td.col-graph svg')!;
        // First parent keeps the merge's own lane, the second opens a new
        // one - two distinct lower-half curves out of the merge row.
        expect(mergeSvg.querySelectorAll('path')).toHaveLength(2);

        // Two lanes now active -> the graph column is sized for both.
        const graphHeader = document.querySelector<HTMLElement>('#commit-table th.col-graph')!;
        expect(graphHeader.style.width).toBe('28px');
    });

    it('draws exactly one dot per row - the row\'s own commit, never a passthrough lane', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                // merge opens two lanes (p1 keeps lane 0, p2 opens lane 1).
                commit({ hash: 'merge', parentHashes: ['p1', 'p2'] }),
                // Neither lane resolves until p1/p2 below - unrelated sits
                // between them, on its own third lane, while both are still
                // passing through it on plain lines.
                commit({ hash: 'unrelated', parentHashes: [] }),
                commit({ hash: 'p1', parentHashes: [] }),
                commit({ hash: 'p2', parentHashes: [] }),
            ],
            hasMore: false,
        });

        // A dot means "a commit happened here" - p1's and p2's lanes are
        // just passing through this row, not resolving on it, so they stay
        // plain lines with no dot of their own; only unrelated's real node
        // gets one.
        const unrelatedSvg = document.querySelector('#commit-tbody tr[data-sha="unrelated"] td.col-graph svg')!;
        expect(unrelatedSvg.querySelectorAll('circle')).toHaveLength(1);
    });

    it('hides the graph column entirely when a column sort is active', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', authorName: 'Bob' }), commit({ hash: 'h2', authorName: 'Alice' })],
            hasMore: false,
        });
        expect(document.getElementById('commit-table')?.classList.contains('graph-hidden')).toBe(false);

        const authorTh = document.querySelector('#commit-table th[data-col="authorName"]')!;
        click(authorTh);

        expect(document.getElementById('commit-table')?.classList.contains('graph-hidden')).toBe(true);
    });

    it('reconnects around a filtered-out commit instead of leaving a dangling line', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        // h1 -> h2 -> h3, h2 will be filtered out - the graph should still
        // connect h1 straight down to h3 rather than dangling on h2.
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                commit({ hash: 'h1', subject: 'keep-me', parentHashes: ['h2'] }),
                commit({ hash: 'h2', subject: 'filter-me-out', parentHashes: ['h3'] }),
                commit({ hash: 'h3', subject: 'keep-me too', parentHashes: [] }),
            ],
            hasMore: false,
        });

        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        filterInput.value = 'keep-me';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        const row2 = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        expect(row2.classList.contains('filtered-out')).toBe(true);

        // Both still-visible rows stay on lane 0 (a single straight-down
        // curve running through where h2 used to connect - x never moves
        // off 0.5), not two dangling ends.
        const row1Svg = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg')!;
        const row3Svg = document.querySelector('#commit-tbody tr[data-sha="h3"] td.col-graph svg')!;
        const row1Path = row1Svg.querySelector('path')!;
        const row3Path = row3Svg.querySelector('path')!;
        // jsdom has no real layout engine (every rect measures 0), so
        // renderCommitGraph() falls back to DEFAULT_ROW_HEIGHT (22) - lane
        // 0's center is x=7 (half of the 14px GRAPH_LANE_WIDTH), row
        // center y=11 (half of 22).
        expect(row1Path.getAttribute('d')).toBe('M 7 11 C 7 16.5 7 16.5 7 22');
        expect(row3Path.getAttribute('d')).toBe('M 7 0 C 7 5.5 7 5.5 7 11');

        // The graph column stays a single lane wide - h2 being excluded
        // never opened a second one.
        const graphHeader = document.querySelector<HTMLElement>('#commit-table th.col-graph')!;
        expect(graphHeader.style.width).toBe('14px');
    });

    it('uses graphEdges to connect commits a path-scoped view never returned itself', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo/some-file.ts', isFile: true });
        // h1 and h3 are the only two commits that touched some-file.ts (what
        // a scoped File Log query actually returns as `commits`), but h1's
        // real parent is h2 - which never touched the file, so it's not in
        // `commits` at all. graphEdges (the unscoped supporting data) is the
        // only place h2's own real parent link (-> h3) exists; without it,
        // h1 would have nothing to connect to and stay dangling.
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [
                commit({ hash: 'h1', parentHashes: ['h2'] }),
                commit({ hash: 'h3', parentHashes: [] }),
            ],
            graphEdges: [
                // Deliberately also includes h1 itself, duplicating what
                // `commits` already has - graphEdges' own recent unscoped
                // batch legitimately can overlap with the scoped commits,
                // and the merge is expected to dedupe rather than process
                // h1 twice.
                commit({ hash: 'h1', parentHashes: ['h2'] }),
                commit({ hash: 'h2', parentHashes: ['h3'] }),
            ],
            hasMore: false,
        });

        const row1Svg = document.querySelector('#commit-tbody tr[data-sha="h1"] td.col-graph svg')!;
        const row3Svg = document.querySelector('#commit-tbody tr[data-sha="h3"] td.col-graph svg')!;
        // Same lane-0-straight-through shape as the client-side-filter
        // case above - h1 connects to h3, not left dangling on h2.
        expect(row1Svg.querySelector('path')!.getAttribute('d')).toBe('M 7 11 C 7 16.5 7 16.5 7 22');
        expect(row3Svg.querySelector('path')!.getAttribute('d')).toBe('M 7 0 C 7 5.5 7 5.5 7 11');
    });
});

describe('log mode: clear filters', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows "Clear Filters" in the files-panel menu even with no active filters', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        const filesPanel = document.getElementById('files-changed-panel')!;
        rightClick(filesPanel);

        expect(document.getElementById('ctx-clear-filters')?.style.display).toBe('');
    });

    it('shows "Clear Filters" in the commit-panel menu even with no active filters', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        const commitListPanel = document.getElementById('commit-list-panel')!;
        rightClick(commitListPanel);

        expect(document.getElementById('ctx-commit-clear-filters')?.style.display).toBe('');
    });

    it('clears filter values, resets sort order, and reloads on click (files panel)', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', authorName: 'Bob' }), commit({ hash: 'h2', authorName: 'Alice' })],
            hasMore: false,
        });

        // Sort by author, then filter.
        const authorTh = document.querySelector('#commit-table th[data-col="authorName"]')!;
        click(authorTh);
        expect(authorTh.querySelector('.sort-arrow')?.textContent).not.toBe('');

        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="authorName"]')!;
        filterInput.value = 'Alice';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        api.postMessage.mockClear();
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-clear-filters')!);

        // Filter input cleared.
        expect(filterInput.value).toBe('');
        // Sort arrow reset (no column sorted -> blank arrows).
        expect(authorTh.querySelector('.sort-arrow')?.textContent).toBe('');
        // Reloaded from scratch.
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 0, count: 100 });
    });

    it('clears filters and resets sort via the commit-panel menu too', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', authorName: 'Bob' })],
            hasMore: false,
        });

        const authorTh = document.querySelector('#commit-table th[data-col="authorName"]')!;
        click(authorTh);

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-commit-clear-filters')!);

        expect(authorTh.querySelector('.sort-arrow')?.textContent).toBe('');
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 0, count: 100 });
    });

    it('clears an active date-range filter too, not just text filters', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        const dateInputs = document.querySelectorAll<HTMLInputElement>('#commit-table input[type="date"]');
        const fromInput = dateInputs[0];
        const toInput = dateInputs[1];
        fromInput.value = '2024-01-01';
        fromInput.dispatchEvent(new Event('input', { bubbles: true }));
        toInput.value = '2024-06-30';
        toInput.dispatchEvent(new Event('input', { bubbles: true }));

        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-commit-clear-filters')!);

        expect(fromInput.value).toBe('');
        expect(toInput.value).toBe('');
        // A subsequent reload shouldn't carry the cleared date range along.
        const lastCall = api.postMessage.mock.calls[api.postMessage.mock.calls.length - 1][0];
        expect(lastCall.after).toBeUndefined();
        expect(lastCall.before).toBeUndefined();
    });
});

describe('log mode: commit selection', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('supports ctrl-click multi-select up to 2, dropping the oldest on a 3rd', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' }), commit({ hash: 'h3' })],
            hasMore: false,
        });
        // "h1" (the first row) is already selected via auto-select-on-load.

        const row2 = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        const row3 = document.querySelector('#commit-tbody tr[data-sha="h3"]')!;
        click(row2, { ctrlKey: true }); // selection: h1, h2
        click(row3, { ctrlKey: true }); // selection full (2) -> drops oldest (h1), adds h3: h2, h3

        const selected = () => Array.from(document.querySelectorAll('#commit-tbody tr.selected')).map(r => (r as HTMLElement).dataset.sha).sort();
        expect(selected()).toEqual(['h2', 'h3']);
    });
});

describe('log mode: file context menu actions', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    async function setupWithSelectedFile() {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
            hasMore: false,
        });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'a.ts', status: 'M' })],
        });
        api.postMessage.mockClear();
        const fileRow = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(fileRow);
        return { api, fileRow };
    }

    it('sends compareWithPrevious with the previous row sha', async () => {
        const { api } = await setupWithSelectedFile();
        click(document.getElementById('ctx-compare')!);
        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'compareWithPrevious',
            sha: 'h1',
            previousSha: 'h2',
            filePath: 'a.ts',
            status: 'M',
        }));
    });

    it('sends compareWithPrevious with no previousSha when the selected commit is the last row', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'a.ts', status: 'M' })],
        });
        api.postMessage.mockClear();
        rightClick(document.querySelector('#files-tbody tr.data-row')!);
        click(document.getElementById('ctx-compare')!);

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'compareWithPrevious',
            sha: 'h1',
            previousSha: undefined,
        }));
    });

    it('sends compareWithWorkingTree', async () => {
        const { api } = await setupWithSelectedFile();
        click(document.getElementById('ctx-compare-working')!);
        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'compareWithWorkingTree',
            sha: 'h1',
            filePath: 'a.ts',
        }));
    });

    it('sends blame', async () => {
        const { api } = await setupWithSelectedFile();
        click(document.getElementById('ctx-blame')!);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'blame', sha: 'h1', filePath: 'a.ts' });
    });

    it('sends showFileLog', async () => {
        const { api } = await setupWithSelectedFile();
        click(document.getElementById('ctx-show-file-log')!);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'showFileLog', filePath: 'a.ts' });
    });

    it('sends viewFileContents with the selected commit sha and file path', async () => {
        const { api } = await setupWithSelectedFile();
        click(document.getElementById('ctx-view-file-contents')!);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'viewFileContents', sha: 'h1', filePath: 'a.ts' });
    });

    it('hides View File Contents for a deleted file', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'gone.ts', status: 'D' })],
        });
        api.postMessage.mockClear();
        rightClick(document.querySelector('#files-tbody tr.data-row')!);
        expect(document.getElementById('ctx-view-file-contents')?.style.display).toBe('none');
    });

    it('copies the path to the clipboard', async () => {
        await setupWithSelectedFile();
        click(document.getElementById('ctx-copy-path')!);
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('a.ts');
    });

    it('hides compare/blame items when no commit is selected and an empty area is right-clicked', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [], hasMore: false });
        rightClick(document.getElementById('files-changed-panel')!);
        expect(document.getElementById('ctx-compare')?.style.display).toBe('none');
        expect(document.getElementById('ctx-show-file-log')?.style.display).toBe('none');
        expect(document.getElementById('ctx-view-file-contents')?.style.display).toBe('none');
    });

    it('sends nothing when compare/compare-working/blame/view-contents are clicked with no context file', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [], hasMore: false });
        rightClick(document.getElementById('files-changed-panel')!);

        api.postMessage.mockClear();
        for (const id of ['ctx-compare', 'ctx-compare-working', 'ctx-blame', 'ctx-view-file-contents']) {
            click(document.getElementById(id)!);
        }

        for (const type of ['compareWithPrevious', 'compareWithWorkingTree', 'blame', 'viewFileContents']) {
            expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type }));
        }
    });
});

describe('log mode: folder view toggle', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    async function loadWithFiles(files: ReturnType<typeof file>[]) {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files,
        });
    }

    it('shows a flat list of full paths by default', async () => {
        await loadWithFiles([file({ path: 'src/a.ts' }), file({ path: 'src/nested/b.ts' })]);
        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(el => el.textContent);
        expect(paths).toEqual(['src/a.ts', 'src/nested/b.ts']);
        expect(document.querySelectorAll('#files-tbody .group-header-row')).toHaveLength(0);
    });

    it('groups files by directory with basenames shown, once Folder View is toggled on', async () => {
        await loadWithFiles([file({ path: 'src/a.ts' }), file({ path: 'src/nested/b.ts' }), file({ path: 'src/a2.ts' })]);

        rightClick(document.getElementById('files-changed-panel')!);
        expect(document.getElementById('ctx-folder-view')?.textContent).toBe('Folder View');
        click(document.getElementById('ctx-folder-view')!);

        const headers = Array.from(document.querySelectorAll('#files-tbody .group-header')).map(el => el.textContent);
        expect(headers).toEqual(['src', 'src/nested']);
        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(el => el.textContent);
        expect(paths).toEqual(['a.ts', 'a2.ts', 'b.ts']);
    });

    it('keeps the full path available as a tooltip in folder view', async () => {
        await loadWithFiles([file({ path: 'src/nested/deep/b.ts' })]);
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        const cell = document.querySelector('#files-tbody .col-path') as HTMLElement;
        expect(cell.textContent).toBe('b.ts');
        expect(cell.title).toBe('src/nested/deep/b.ts');
    });

    it('shows a checkmark and reverts to a flat list when toggled off again', async () => {
        await loadWithFiles([file({ path: 'src/a.ts' })]);
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        rightClick(document.getElementById('files-changed-panel')!);
        expect(document.getElementById('ctx-folder-view')?.textContent).toBe('✓ Folder View');
        click(document.getElementById('ctx-folder-view')!);

        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(el => el.textContent);
        expect(paths).toEqual(['src/a.ts']);
        expect(document.querySelectorAll('#files-tbody .group-header-row')).toHaveLength(0);
    });

    it('groups root-level files under a (root) header', async () => {
        await loadWithFiles([file({ path: 'README.md' })]);
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        expect(document.querySelector('#files-tbody .group-header')?.textContent).toBe('(root)');
        expect(document.querySelector('#files-tbody .col-path')?.textContent).toBe('README.md');
    });

    it('shows a shortened rename arrow using basenames in folder view', async () => {
        await loadWithFiles([file({ path: 'src/new/name.ts', oldPath: 'src/old/name.ts', status: 'R' })]);
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        expect(document.querySelector('#files-tbody .col-path')?.textContent).toBe('name.ts → name.ts');
    });

    it('composes folder view with merge-commit parent groups: nests directory under parent group', async () => {
        await loadWithFiles([
            file({ path: 'src/a.ts', parentGroup: 'Diff with parent 1: abc12345' }),
            file({ path: 'src/nested/b.ts', parentGroup: 'Diff with parent 1: abc12345' }),
        ]);
        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        const headers = Array.from(document.querySelectorAll('#files-tbody .group-header')).map(el => el.textContent);
        expect(headers).toEqual(['Diff with parent 1: abc12345 — src', 'Diff with parent 1: abc12345 — src/nested']);
    });
});

describe('log mode: commit context menu', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('opens via right-clicking a commit row directly, not just empty panel space', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        const row = document.querySelector('#commit-tbody tr[data-sha="h1"]')!;
        rightClick(row);

        expect(document.getElementById('commit-context-menu')?.style.display).toBe('block');
    });

    it('sends compareRevisions with older/newer shas resolved from row order', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'newer' }), commit({ hash: 'older' })],
            hasMore: false,
        });

        // "newer" (the first row) is already selected via auto-select-on-load;
        // ctrl-click "older" to bring the selection to both.
        const rowOlder = document.querySelector('#commit-tbody tr[data-sha="older"]')!;
        click(rowOlder, { ctrlKey: true });

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-compare-revisions')?.style.display).toBe('');
        click(document.getElementById('ctx-compare-revisions')!);

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'compareRevisions', sha1: 'older', sha2: 'newer' });
    });

    it('still resolves older/newer correctly when the older commit is selected first', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'newer' }), commit({ hash: 'older' })],
            hasMore: false,
        });

        // Reversed from the test above: select "older" (row 1) first with a
        // plain click, then ctrl-click "newer" (row 0) second - selection
        // order no longer matches row order.
        const rowOlder = document.querySelector('#commit-tbody tr[data-sha="older"]')!;
        click(rowOlder);
        const rowNewer = document.querySelector('#commit-tbody tr[data-sha="newer"]')!;
        click(rowNewer, { ctrlKey: true });

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-compare-revisions')!);

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'compareRevisions', sha1: 'older', sha2: 'newer' });
    });

    it('does nothing if Compare Selected Revisions is invoked without exactly 2 selected', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        api.postMessage.mockClear();
        click(document.getElementById('ctx-compare-revisions')!);

        expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compareRevisions' }));
    });

    it('hides "Compare Selected Revisions" unless exactly 2 commits are selected', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-compare-revisions')?.style.display).toBe('none');
    });

    it('hides the separator leading into Compare Selected Revisions alongside it', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
            hasMore: false,
        });

        // Exactly one selected (h1, auto-selected on load): both hide, or
        // the menu would open on a stray separator line with nothing above
        // it.
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-compare-revisions')?.style.display).toBe('none');
        expect(document.getElementById('ctx-compare-separator')?.style.display).toBe('none');

        // Exactly two selected: both show.
        const row2 = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        click(row2, { ctrlKey: true });
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-compare-revisions')?.style.display).toBe('');
        expect(document.getElementById('ctx-compare-separator')?.style.display).toBe('');
    });
});

describe('log mode: menu dismissal', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('hides open menus on Escape', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('block');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('none');
    });

    it('hides open menus on an outside click', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        rightClick(document.getElementById('files-changed-panel')!);
        expect(document.getElementById('context-menu')?.style.display).toBe('block');

        click(document.body);
        expect(document.getElementById('context-menu')?.style.display).toBe('none');
    });
});

describe('log mode: errors', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows the error message in the detail panel', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'error', message: 'boom <b>bad</b>' });
        const panel = document.getElementById('commit-detail-panel')!;
        expect(panel.innerHTML).toContain('boom &lt;b&gt;bad&lt;/b&gt;');
    });
});

describe('log mode: panel resizing (smoke)', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('does not throw when dragging a horizontal resizer', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        const resizer = document.querySelector('.resizer')!;
        resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 150 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    it('does not throw when resizing a column', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        const colResizer = document.querySelector('#commit-table .col-resizer')!;
        colResizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    it('auto-expands a column on double-click without throwing, measuring existing rows', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        const colResizer = document.querySelector('#commit-table .col-resizer')!;
        colResizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
});

describe('log mode: additional selection + refresh + navigation behavior', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('deselects an already-selected commit on ctrl-click', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1' }), commit({ hash: 'h2' })],
            hasMore: false,
        });
        // h1 auto-selected on load.
        const row1 = document.querySelector('#commit-tbody tr[data-sha="h1"]')!;
        api.postMessage.mockClear();
        click(row1, { ctrlKey: true });

        expect(row1.classList.contains('selected')).toBe(false);
        expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestCommitDetails' }));
    });

    it('clears the detail panel when a filter hides every commit', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', subject: 'fix bug' })],
            hasMore: false,
        });

        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        filterInput.value = 'nothing matches this';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(document.getElementById('commit-detail-panel')?.textContent).toContain('No commits to display');
    });

    it('reloads commits from the commit-panel Refresh item', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-commit-refresh')!);

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 0, count: 100 });
    });

    it('reloads commits from the file-panel Refresh item', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        api.postMessage.mockClear();
        click(document.getElementById('ctx-refresh')!);

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 0, count: 100 });
    });

    it('sends compareWithPrevious on file row double-click when a commit is selected', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'a.ts', status: 'M' })],
        });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'compareWithPrevious',
            sha: 'h1',
            filePath: 'a.ts',
            status: 'M',
        }));
    });

    it('clamps the context menu position to stay within the viewport', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            right: window.innerWidth + 500,
            bottom: window.innerHeight + 500,
            width: 200,
            height: 150,
            left: 0, top: 0, x: 0, y: 0, toJSON() { /* noop */ },
        });

        rightClick(document.getElementById('files-changed-panel')!);

        const menu = document.getElementById('context-menu')!;
        expect(menu.style.left).toBe(`${window.innerWidth - 200}px`);
        expect(menu.style.top).toBe(`${window.innerHeight - 150}px`);
        spy.mockRestore();
    });

    it('toggles the files-table sort direction on repeat clicks of the same column', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        sendFromExtension({
            type: 'commitDetailsLoaded',
            detail: { hash: 'h1', shortHash: 'h1', authorName: 'A', authorEmail: 'a', authorDate: '2024-01-01', body: '' },
            files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })],
        });

        const pathTh = document.querySelector('#files-table th[data-col="path"]')!;
        click(pathTh); // already ascending by default -> clicking toggles to descending
        let paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(td => td.textContent);
        expect(paths).toEqual(['b.ts', 'a.ts']);
        expect(pathTh.querySelector('.sort-arrow')?.textContent).toBe(' ▼');

        click(pathTh);
        paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(td => td.textContent);
        expect(paths).toEqual(['a.ts', 'b.ts']);
    });

    it('loads more commits when the load-more sentinel intersects', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: true });

        api.postMessage.mockClear();
        triggerLoadMoreIntersection(true);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCommits', offset: 1, count: 100 });
    });

    it('does not load more when the sentinel intersects but hasMore is false', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        api.postMessage.mockClear();
        triggerLoadMoreIntersection(true);
        expect(api.postMessage).not.toHaveBeenCalled();
    });

    it('auto-loads more commits when an active filter leaves too few rows visible', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        const commits = Array.from({ length: 5 }, (_, i) => commit({ hash: `h${i}`, subject: i === 0 ? 'keep-me' : 'other' }));
        sendFromExtension({ type: 'commitsLoaded', commits, hasMore: true });

        api.postMessage.mockClear();
        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        filterInput.value = 'keep-me';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'requestCommits', offset: 5 }));
    });

    it('keeps an active filter applied to newly-appended rows from a load-more page', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h1', subject: 'keep-me' })],
            hasMore: true,
        });

        const filterInput = document.querySelector<HTMLInputElement>('#commit-table input[data-col="subject"]')!;
        filterInput.value = 'keep-me';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        // A second page of commits arrives (e.g. from infinite scroll) while
        // the subject filter is still active. renderCommits() rebuilds the
        // whole tbody from scratch, which would otherwise show the new
        // non-matching row until the next keystroke re-applied the filter -
        // it must re-apply the still-active filter itself.
        api.postMessage.mockClear();
        sendFromExtension({
            type: 'commitsLoaded',
            commits: [commit({ hash: 'h2', subject: 'other' })],
            hasMore: false,
        });

        const h1Row = document.querySelector('#commit-tbody tr[data-sha="h1"]')!;
        const h2Row = document.querySelector('#commit-tbody tr[data-sha="h2"]')!;
        expect(h1Row.classList.contains('filtered-out')).toBe(false);
        expect(h2Row.classList.contains('filtered-out')).toBe(true);
    });

    it('reloads with a server-side "to" date range when the to-date filter changes', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        api.postMessage.mockClear();

        const toInput = document.querySelectorAll<HTMLInputElement>('#commit-table input[type="date"]')[1];
        toInput.value = '2024-06-30';
        toInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits',
            offset: 0,
            before: '2024-06-30T23:59:59',
        }));
    });
});

describe('log mode: branches submenu', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    async function openBranchesSubmenu(api: { postMessage: ReturnType<typeof vi.fn> }, branches: string[]) {
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-branches')!);
        sendFromExtension({ type: 'branchesLoaded', branches });
    }

    it('shows a default label and sends no branch filter by default', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-branches')?.textContent).toBe('Branches');

        const initialRequest = api.postMessage.mock.calls[0][0];
        expect(initialRequest.branches).toBeUndefined();
    });

    it('requests the branch list only the first time the submenu is opened', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-branches')!);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestBranches' });
        sendFromExtension({ type: 'branchesLoaded', branches: ['main', 'feature/x'] });

        api.postMessage.mockClear();
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-branches')!);
        expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'requestBranches' });
    });

    it('renders "All" plus a checkable row per branch once loaded', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main', 'feature/x']);

        const items = Array.from(document.querySelectorAll('#branches-submenu .context-menu-item')).map(el => el.textContent);
        expect(items).toEqual(['All', 'main', 'feature/x']);
    });

    it('selecting "All" reloads with branches: "all", updates the label, and closes the menu', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main', 'feature/x']);

        api.postMessage.mockClear();
        const allItem = Array.from(document.querySelectorAll('#branches-submenu .context-menu-item'))
            .find(el => el.textContent === 'All')!;
        click(allItem);

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits', offset: 0, branches: 'all',
        }));
        expect(document.getElementById('commit-context-menu')?.style.display).toBe('none');
        expect(document.getElementById('branches-submenu')?.style.display).toBe('none');

        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-branches')?.textContent).toBe('Branches: All');
    });

    it('selecting specific branches multi-selects, reloads, and keeps the menu open', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main', 'feature/x']);

        api.postMessage.mockClear();
        const mainItem = Array.from(document.querySelectorAll('#branches-submenu .context-menu-item'))
            .find(el => el.textContent === 'main')!;
        click(mainItem);

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits', offset: 0, branches: ['main'],
        }));
        // Multi-select: the submenu stays open so a second branch can be picked.
        expect(document.getElementById('branches-submenu')?.style.display).toBe('block');
        const mainAfterClick = Array.from(document.querySelectorAll('#branches-submenu .context-menu-item'))
            .find(el => el.textContent?.includes('main'))!;
        expect(mainAfterClick.textContent).toBe('✓ main');

        const featureItem = Array.from(document.querySelectorAll('#branches-submenu .context-menu-item'))
            .find(el => el.textContent === 'feature/x')!;
        click(featureItem);

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits', offset: 0, branches: ['main', 'feature/x'],
        }));

        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-branches')?.textContent).toBe('Branches: 2 selected');
    });

    it('selecting a specific branch clears an "All" selection, and vice versa', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main']);

        const allItem = () => Array.from(document.querySelectorAll('#branches-submenu .context-menu-item')).find(el => el.textContent?.includes('All'))!;
        const mainItem = () => Array.from(document.querySelectorAll('#branches-submenu .context-menu-item')).find(el => el.textContent?.includes('main'))!;

        click(allItem());
        rightClick(document.getElementById('commit-list-panel')!);
        click(document.getElementById('ctx-branches')!);
        expect(allItem().textContent).toBe('✓ All');

        click(mainItem());
        expect(allItem().textContent).toBe('All');
        expect(mainItem().textContent).toBe('✓ main');
    });

    it('is hidden in line-history mode, and so is the commit graph column', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo/file.ts', isFile: true, lineStart: 5, lineEnd: 10 });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });

        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-branches')?.style.display).toBe('none');
        // -L history is a line's own provenance, not commit topology - not
        // something git's -L mode is designed to be graphed against.
        expect(document.getElementById('commit-table')?.classList.contains('graph-hidden')).toBe(true);
    });

    it('clicking "Branches" again while the submenu is already open closes it', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main']);
        expect(document.getElementById('branches-submenu')?.style.display).toBe('block');

        click(document.getElementById('ctx-branches')!);

        expect(document.getElementById('branches-submenu')?.style.display).toBe('none');
    });

    it('clicking an already-selected branch deselects it', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        await openBranchesSubmenu(api, ['main', 'feature/x']);

        const mainItem = () => Array.from(document.querySelectorAll('#branches-submenu .context-menu-item')).find(el => el.textContent?.includes('main'))!;
        click(mainItem()); // select
        expect(mainItem().textContent).toBe('✓ main');

        api.postMessage.mockClear();
        click(mainItem()); // deselect

        expect(mainItem().textContent).toBe('main');
        const lastCall = api.postMessage.mock.calls[api.postMessage.mock.calls.length - 1][0];
        expect(lastCall.branches).toBeUndefined();
    });
});

describe('log mode: configurable page size', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('uses the pageSize from initialState for requestCommits count', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false, pageSize: 25 });

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits', offset: 0, count: 25,
        }));
    });

    it('defaults to 100 when pageSize is not provided', async () => {
        const { api } = await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestCommits', offset: 0, count: 100,
        }));
    });
});
