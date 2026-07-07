import { vi } from 'vitest';

// Faithful copies of the <body> markup gitLogPanel.ts generates for each mode
// (src/gitLogPanel.ts getLogHtml/getCompareHtml/getBlameHtml), minus the
// <script> tags — main.ts is imported directly instead of loaded via <script>.

export const LOG_BODY = `
<div id="app">
    <div id="commit-list-panel" class="panel">
        <table id="commit-table">
            <thead><tr>
                <th class="col-sha" data-col="shortHash">SHA-1<span class="sort-arrow"></span></th>
                <th class="col-message" data-col="subject">Message<span class="sort-arrow"></span></th>
                <th class="col-author" data-col="authorName">Author<span class="sort-arrow"></span></th>
                <th class="col-date" data-col="authorDate">Date<span class="sort-arrow"></span></th>
            </tr></thead>
            <tbody id="commit-tbody"></tbody>
        </table>
        <div id="load-more">Loading...</div>
    </div>
    <div class="resizer"></div>
    <div id="commit-detail-panel" class="panel">
        <div class="empty-state">Select a commit to view details</div>
    </div>
    <div class="resizer"></div>
    <div id="files-changed-panel" class="panel">
        <table id="files-table">
            <thead><tr>
                <th class="col-path" data-col="path">Path<span class="sort-arrow"> ▲</span></th>
                <th class="col-status" data-col="status">Status<span class="sort-arrow"></span></th>
                <th class="col-additions" data-col="additions">+<span class="sort-arrow"></span></th>
                <th class="col-deletions" data-col="deletions">-<span class="sort-arrow"></span></th>
            </tr></thead>
            <tbody id="files-tbody"></tbody>
        </table>
    </div>
</div>
<div id="context-menu" class="context-menu" style="display:none;">
    <div class="context-menu-item" id="ctx-show-file-log">Show File Log</div>
    <div class="context-menu-item" id="ctx-compare">Compare with Previous</div>
    <div class="context-menu-item" id="ctx-compare-working">Compare with Working Tree</div>
    <div class="context-menu-item" id="ctx-blame">Blame</div>
    <div class="context-menu-item" id="ctx-copy-path">Copy Path</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="ctx-clear-filters" style="display:none;">Clear Filters</div>
    <div class="context-menu-item" id="ctx-refresh">Refresh</div>
</div>
<div id="commit-context-menu" class="context-menu" style="display:none;">
    <div class="context-menu-item" id="ctx-compare-revisions">Compare Selected Revisions</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="ctx-commit-clear-filters" style="display:none;">Clear Filters</div>
    <div class="context-menu-item" id="ctx-commit-refresh">Refresh</div>
</div>
`;

export const COMPARE_BODY = `
<div id="app" class="compare-mode">
    <div id="compare-header" class="compare-header"></div>
    <div id="compare-details" class="compare-details">
        <div id="compare-detail-1" class="compare-detail-pane">
            <div class="empty-state">Loading...</div>
        </div>
        <div class="resizer-col" id="compare-resizer-col"></div>
        <div id="compare-detail-2" class="compare-detail-pane">
            <div class="empty-state">Loading...</div>
        </div>
    </div>
    <div class="resizer"></div>
    <div id="files-changed-panel" class="panel">
        <table id="files-table">
            <thead><tr>
                <th class="col-path" data-col="path">Path<span class="sort-arrow"> ▲</span></th>
                <th class="col-status" data-col="status">Status<span class="sort-arrow"></span></th>
                <th class="col-additions" data-col="additions">+<span class="sort-arrow"></span></th>
                <th class="col-deletions" data-col="deletions">-<span class="sort-arrow"></span></th>
            </tr></thead>
            <tbody id="files-tbody"></tbody>
        </table>
    </div>
</div>
<div id="context-menu" class="context-menu" style="display:none;">
    <div class="context-menu-item" id="ctx-show-file-log">Show File Log</div>
    <div class="context-menu-item" id="ctx-compare" style="display:none;">Compare with Previous</div>
    <div class="context-menu-item" id="ctx-compare-working" style="display:none;">Compare with Working Tree</div>
    <div class="context-menu-item" id="ctx-blame">Blame</div>
    <div class="context-menu-item" id="ctx-copy-path">Copy Path</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="ctx-clear-filters" style="display:none;">Clear Filters</div>
    <div class="context-menu-item" id="ctx-refresh">Refresh</div>
</div>
`;

export const BLAME_BODY = `
<div id="app" class="blame-mode">
    <div id="blame-main">
        <div id="blame-gutter-panel" class="panel">
            <table id="blame-gutter-table">
                <tbody id="blame-gutter-tbody"></tbody>
            </table>
        </div>
        <div id="blame-code-panel" class="panel">
            <table id="blame-code-table">
                <tbody id="blame-code-tbody"></tbody>
            </table>
        </div>
    </div>
    <div class="resizer-col" id="blame-resizer-col"></div>
    <div id="blame-commit-info" class="panel">
        <div class="empty-state">Hover over a revision to see commit details</div>
    </div>
</div>
<div id="context-menu" class="context-menu" style="display:none;">
    <div class="context-menu-item" id="ctx-show-file-log" style="display:none;">Show File Log</div>
    <div class="context-menu-item" id="ctx-compare" style="display:none;">Compare with Previous</div>
    <div class="context-menu-item" id="ctx-compare-working" style="display:none;">Compare with Working Tree</div>
    <div class="context-menu-item" id="ctx-blame" style="display:none;">Blame</div>
    <div class="context-menu-item" id="ctx-copy-path" style="display:none;">Copy Path</div>
</div>
`;

export interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    setState: ReturnType<typeof vi.fn>;
}

export interface InitialStateInput {
    mode: 'log' | 'compare' | 'blame';
    targetPath?: string;
    isFile?: boolean;
    sha1?: string;
    sha2?: string;
    blameSha?: string;
    blameFilePath?: string;
}

/**
 * Resets the DOM + module registry, injects a fresh mocked VS Code webview
 * API and initialState, then imports webview/main.ts (which runs its
 * top-level setup and initial postMessage as a side effect of import).
 */
export async function loadWebview(initialState: InitialStateInput): Promise<{ api: MockVsCodeApi }> {
    vi.resetModules();

    const body = initialState.mode === 'compare' ? COMPARE_BODY
        : initialState.mode === 'blame' ? BLAME_BODY
        : LOG_BODY;
    document.body.innerHTML = body;

    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
    };
    (window as unknown as { acquireVsCodeApi: () => MockVsCodeApi }).acquireVsCodeApi = () => api;
    (window as unknown as { initialState: InitialStateInput }).initialState = initialState;

    Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn() },
        configurable: true,
    });

    // jsdom doesn't implement IntersectionObserver; main.ts's infinite-scroll
    // setup constructs one unconditionally at import time in log mode.
    lastIntersectionCallback = null;
    class MockIntersectionObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback) { lastIntersectionCallback = callback; }
    }
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;

    await import('../main');
    return { api };
}

/** Simulates the extension host pushing a message to the webview. */
export function sendFromExtension(msg: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

let lastIntersectionCallback: IntersectionObserverCallback | null = null;

/** Fires the #load-more IntersectionObserver callback registered by main.ts. */
export function triggerLoadMoreIntersection(isIntersecting: boolean): void {
    lastIntersectionCallback?.(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
    );
}
