// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadWebview, sendFromExtension } from './harness';

function file(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        path: 'src/foo.ts',
        status: 'M',
        additions: 1,
        deletions: 1,
        ...overrides,
    };
}

function detail(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        hash: 'sha1234567890',
        shortHash: 'sha1234',
        authorName: 'Alice',
        authorEmail: 'a@x.com',
        authorDate: '2024-01-01T00:00:00-05:00',
        body: 'Some change',
        ...overrides,
    };
}

function rightClick(el: Element): void {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }));
}

describe('compare mode', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('requests compare files on load and renders both detail panes + file list', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCompareFiles' });

        sendFromExtension({
            type: 'compareFilesLoaded',
            detail1: detail({ shortHash: 'aaa111x' }),
            detail2: detail({ shortHash: 'bbb222x', authorName: 'Bob' }),
            files: [file({ path: 'b.ts' }), file({ path: 'a.ts' })],
        });

        expect(document.getElementById('compare-detail-1')?.textContent).toContain('aaa111x');
        expect(document.getElementById('compare-detail-2')?.textContent).toContain('Bob');
        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(td => td.textContent);
        expect(paths).toEqual(['a.ts', 'b.ts']);
    });

    it('shows a literal 0 rather than +0/-0 for a file with no additions or deletions', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({
            type: 'compareFilesLoaded',
            files: [file({ path: 'renamed-only.ts', additions: 0, deletions: 0 })],
        });

        expect(document.querySelector('#files-tbody .col-additions')?.textContent).toBe('0');
        expect(document.querySelector('#files-tbody .col-deletions')?.textContent).toBe('0');
    });

    it('re-applies an active filter when the file list re-renders', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({
            type: 'compareFilesLoaded',
            files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })],
        });

        const filterInput = document.querySelector<HTMLInputElement>('#files-table input[data-col="path"]')!;
        filterInput.value = 'a';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.querySelector('#files-tbody tr[data-path="b.ts"]')?.classList.contains('filtered-out')).toBe(true);

        // Re-sending the same data re-runs renderFiles() from scratch; the
        // filter should still apply to the freshly rendered rows.
        sendFromExtension({
            type: 'compareFilesLoaded',
            files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })],
        });
        expect(document.querySelector('#files-tbody tr[data-path="b.ts"]')?.classList.contains('filtered-out')).toBe(true);
        expect(document.querySelector('#files-tbody tr[data-path="a.ts"]')?.classList.contains('filtered-out')).toBe(false);
    });

    it('skips rendering a detail pane when not provided', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', files: [] });
        expect(document.getElementById('compare-detail-1')?.textContent).toContain('Loading...');
    });

    it('always shows compare/blame items in the file context menu regardless of selection', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', detail1: detail(), detail2: detail(), files: [file()] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(row);
        expect(document.getElementById('ctx-compare')?.style.display).toBe('');
        expect(document.getElementById('ctx-compare-working')?.style.display).toBe('');
        expect(document.getElementById('ctx-blame')?.style.display).toBe('');
    });

    it('sends viewFileContents resolved via state.sha2', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', detail1: detail(), detail2: detail(), files: [file({ path: 'a.ts' })] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(row);
        click(document.getElementById('ctx-view-file-contents')!);

        expect(api.postMessage).toHaveBeenCalledWith({ type: 'viewFileContents', sha: 'bbb222', filePath: 'a.ts' });
    });

    it('hides View File Contents for a deleted file even in compare mode', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', detail1: detail(), detail2: detail(), files: [file({ path: 'gone.ts', status: 'D' })] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(row);
        expect(document.getElementById('ctx-view-file-contents')?.style.display).toBe('none');
    });

    it('groups the file list by directory in folder view', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({
            type: 'compareFilesLoaded',
            detail1: detail(),
            detail2: detail(),
            files: [file({ path: 'src/a.ts' }), file({ path: 'src/nested/b.ts' })],
        });

        rightClick(document.getElementById('files-changed-panel')!);
        click(document.getElementById('ctx-folder-view')!);

        const headers = Array.from(document.querySelectorAll('#files-tbody .group-header')).map(el => el.textContent);
        expect(headers).toEqual(['src', 'src/nested']);
        const paths = Array.from(document.querySelectorAll('#files-tbody .col-path')).map(el => el.textContent);
        expect(paths).toEqual(['a.ts', 'b.ts']);
    });

    it('resolves the file-list sha via state.sha2 when no commit list exists', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', detail1: detail(), detail2: detail(), files: [file({ path: 'a.ts' })] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(row);
        click(document.getElementById('ctx-compare-working')!);

        expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'compareWithWorkingTree',
            sha: 'bbb222',
            filePath: 'a.ts',
        }));
    });

    it('sends compareFile on double-click', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({ type: 'compareFilesLoaded', detail1: detail(), detail2: detail(), files: [file({ path: 'a.ts', oldPath: 'old.ts', status: 'R' })] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        expect(api.postMessage).toHaveBeenCalledWith({
            type: 'compareFile',
            filePath: 'a.ts',
            oldPath: 'old.ts',
            status: 'R',
        });
    });

    it('refreshes by re-requesting compare files', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        api.postMessage.mockClear();
        click(document.getElementById('ctx-refresh')!);
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestCompareFiles' });
    });

    it('clears filters and re-renders the file list in place (no reload)', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        sendFromExtension({
            type: 'compareFilesLoaded',
            detail1: detail(),
            detail2: detail(),
            files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })],
        });

        const filterInput = document.querySelector<HTMLInputElement>('#files-table input[data-col="path"]')!;
        filterInput.value = 'a';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.querySelector('#files-tbody tr[data-path="b.ts"]')?.classList.contains('filtered-out')).toBe(true);

        api.postMessage.mockClear();
        click(document.getElementById('ctx-clear-filters')!);

        expect(filterInput.value).toBe('');
        expect(document.querySelector('#files-tbody tr[data-path="b.ts"]')?.classList.contains('filtered-out')).toBe(false);
        // No server round-trip in compare mode.
        expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'requestCompareFiles' });
    });

    it('drags the vertical (column) resizer without throwing', async () => {
        await loadWebview({ mode: 'compare', sha1: 'aaa111', sha2: 'bbb222' });
        const resizer = document.getElementById('compare-resizer-col')!;
        resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    it('does nothing when no sha can be resolved for the file list (no sha2, nothing selected)', async () => {
        const { api } = await loadWebview({ mode: 'compare', sha1: 'aaa111' });
        sendFromExtension({ type: 'compareFilesLoaded', files: [file({ path: 'a.ts' })] });

        const row = document.querySelector('#files-tbody tr.data-row')!;
        rightClick(row);
        click(document.getElementById('ctx-compare-working')!);

        expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compareWithWorkingTree' }));
    });
});
