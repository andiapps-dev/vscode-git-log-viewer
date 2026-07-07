// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadWebview, sendFromExtension, triggerLoadMoreIntersection } from './harness';

function commit(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        hash: 'hash-' + Math.random().toString(36).slice(2),
        shortHash: 'abc1234',
        subject: 'a commit',
        authorName: 'Alice',
        authorDate: '2024-01-01T00:00:00-05:00',
        refs: '',
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
    });
});

describe('log mode: commit context menu', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
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

    it('hides "Compare Selected Revisions" unless exactly 2 commits are selected', async () => {
        await loadWebview({ mode: 'log', targetPath: '/repo', isFile: false });
        sendFromExtension({ type: 'commitsLoaded', commits: [commit({ hash: 'h1' })], hasMore: false });
        rightClick(document.getElementById('commit-list-panel')!);
        expect(document.getElementById('ctx-compare-revisions')?.style.display).toBe('none');
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
