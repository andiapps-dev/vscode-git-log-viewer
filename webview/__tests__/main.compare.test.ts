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
