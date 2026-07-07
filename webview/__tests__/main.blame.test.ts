// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadWebview, sendFromExtension } from './harness';

function line(overrides: Partial<Record<string, unknown>> = {}) {
    const sha = (overrides.sha as string) || 'sha1';
    return {
        sha,
        shortSha: sha,
        author: 'Alice',
        authorEmail: 'a@x.com',
        timestamp: 1700000000,
        date: '2024-01-01',
        summary: 'a commit',
        lineNo: 1,
        content: 'const x = 1;',
        ...overrides,
    };
}

function detail(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        hash: 'sha1full',
        shortHash: 'sha1',
        authorName: 'Alice',
        authorEmail: 'a@x.com',
        authorDate: '2024-01-01T00:00:00-05:00',
        body: 'Subject line\n\nBody detail here',
        ...overrides,
    };
}

describe('blame mode', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('requests blame data on load and renders gutter + code rows', async () => {
        const { api } = await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'requestBlameData' });

        sendFromExtension({
            type: 'blameDataLoaded',
            lines: [line({ lineNo: 1, sha: 'sha1' }), line({ lineNo: 2, sha: 'sha1' }), line({ lineNo: 3, sha: 'sha2' })],
            commits: { sha1: detail({ hash: 'sha1' }), sha2: detail({ hash: 'sha2' }) },
        });

        const gutterRows = document.querySelectorAll('#blame-gutter-tbody tr.blame-row');
        const codeRows = document.querySelectorAll('#blame-code-tbody tr.blame-row');
        expect(gutterRows.length).toBe(3);
        expect(codeRows.length).toBe(3);
        // First row of each new sha-block shows the short sha/author/time; continuation rows are blank.
        expect(gutterRows[0].querySelector('.blame-sha')?.textContent).toBe('sha1');
        expect(gutterRows[1].querySelector('.blame-sha')?.textContent).toBe('');
        expect(gutterRows[2].querySelector('.blame-sha')?.textContent).toBe('sha2');
    });

    it('highlights and shows commit info on hover, and locks on click', async () => {
        await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        sendFromExtension({
            type: 'blameDataLoaded',
            lines: [line({ lineNo: 1, sha: 'sha1' })],
            commits: { sha1: detail({ hash: 'sha1', body: 'Fix bug\n\nDetails here' }) },
        });

        const gutterRow = document.querySelector('#blame-gutter-tbody tr.blame-row')!;
        gutterRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

        expect(gutterRow.classList.contains('blame-highlight')).toBe(true);
        const info = document.getElementById('blame-commit-info')!;
        expect(info.textContent).toContain('Fix bug');
        expect(info.querySelector('.detail-body')?.textContent).toContain('Details here');

        // Click locks the selection; a second click on the same row unlocks it.
        gutterRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(gutterRow.classList.contains('blame-highlight')).toBe(true);
        gutterRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(gutterRow.classList.contains('blame-highlight')).toBe(false);
        expect(info.textContent).toContain('Hover over a revision');
    });

    it('ignores hover while a different row is locked', async () => {
        await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        sendFromExtension({
            type: 'blameDataLoaded',
            lines: [line({ lineNo: 1, sha: 'sha1' }), line({ lineNo: 2, sha: 'sha2' })],
            commits: { sha1: detail({ hash: 'sha1' }), sha2: detail({ hash: 'sha2' }) },
        });

        const rows = document.querySelectorAll('#blame-gutter-tbody tr.blame-row');
        rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); // lock sha1
        rows[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); // hover sha2, should be ignored

        expect(rows[0].classList.contains('blame-highlight')).toBe(true);
        expect(rows[1].classList.contains('blame-highlight')).toBe(false);
    });

    it('renders without a body line when the commit has no extended body', async () => {
        await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        sendFromExtension({
            type: 'blameDataLoaded',
            lines: [line({ lineNo: 1, sha: 'sha1' })],
            commits: { sha1: detail({ hash: 'sha1', body: 'Just a subject' }) },
        });
        const gutterRow = document.querySelector('#blame-gutter-tbody tr.blame-row')!;
        gutterRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const info = document.getElementById('blame-commit-info')!;
        expect(info.querySelector('.detail-body')).toBeNull();
    });

    it('syncs scroll position between the gutter and code panels', async () => {
        await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        sendFromExtension({
            type: 'blameDataLoaded',
            lines: [line({ lineNo: 1, sha: 'sha1' })],
            commits: { sha1: detail({ hash: 'sha1' }) },
        });

        const gutterPanel = document.getElementById('blame-gutter-panel')!;
        const codePanel = document.getElementById('blame-code-panel')!;

        Object.defineProperty(gutterPanel, 'scrollTop', { value: 42, writable: true, configurable: true });
        gutterPanel.dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(codePanel.scrollTop).toBe(42);

        Object.defineProperty(codePanel, 'scrollTop', { value: 77, writable: true, configurable: true });
        codePanel.dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(gutterPanel.scrollTop).toBe(77);
    });

    it('drags the vertical resizer without throwing', async () => {
        await loadWebview({ mode: 'blame', blameSha: 'sha1', blameFilePath: 'a.ts' });
        const resizer = document.getElementById('blame-resizer-col')!;
        resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
});
