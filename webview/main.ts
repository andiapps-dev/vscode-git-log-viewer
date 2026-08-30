import { sortArray, statusClass, statusLabel, escapeHtml, formatDate, formatTimeAgo } from './utils';

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
    }
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
            const ths = thead.querySelectorAll('th[data-col]');
            ths.forEach((th, i) => {
                const col = (th as HTMLElement).dataset.col || '';
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
