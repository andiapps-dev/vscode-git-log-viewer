import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from './gitService';
import { DiffDocProvider } from './diffDocProvider';
import { safeJsonStringify } from './utils';
import {
    InitialState,
    CommitDetail,
    RequestCommitsMessage,
    RequestCommitDetailsMessage,
    CompareWithPreviousMessage,
    CompareWithWorkingTreeMessage,
    BlameMessage,
    CompareRevisionsMessage,
    CompareFileMessage,
    ShowFileLogMessage,
} from './types';

const openPanels = new Map<string, GitLogPanel>();

export class GitLogPanel {
    private panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private repoRoot: string = '';
    private initialState: InitialState;
    private ready: Promise<void> = Promise.resolve();

    private constructor(
        private extensionUri: vscode.Uri,
        private gitService: GitService,
        panelTitle: string,
        initState: InitialState,
        private panelKey: string,
    ) {
        this.initialState = initState;
        this.panel = vscode.window.createWebviewPanel(
            'gitLogViewer',
            panelTitle,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
            },
        );

        this.panel.iconPath = new vscode.ThemeIcon('git-commit');
        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    static createLogPanel(
        extensionUri: vscode.Uri,
        targetPath: string,
        gitService: GitService,
    ): void {
        const key = `log:${targetPath}`;
        const existing = openPanels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        const label = path.basename(targetPath);
        let isFile = false;
        try { isFile = fs.statSync(targetPath).isFile(); } catch { /* */ }
        const initState: InitialState = { mode: 'log', targetPath, isFile };
        const panel = new GitLogPanel(extensionUri, gitService, `Git Log: ${label}`, initState, key);
        openPanels.set(key, panel);
        panel.ready = panel.initRepoRoot(targetPath);
    }

    static createComparePanel(
        extensionUri: vscode.Uri,
        repoRoot: string,
        sha1: string,
        sha2: string,
        gitService: GitService,
    ): void {
        const key = `compare:${sha1}:${sha2}`;
        const existing = openPanels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        const short1 = sha1.substring(0, 8);
        const short2 = sha2.substring(0, 8);
        const title = `Compare: ${short1} ↔ ${short2}`;
        const initState: InitialState = { mode: 'compare', sha1, sha2 };
        const panel = new GitLogPanel(extensionUri, gitService, title, initState, key);
        panel.repoRoot = repoRoot;
        openPanels.set(key, panel);
    }

    static createFileLogPanel(
        extensionUri: vscode.Uri,
        repoRoot: string,
        filePath: string,
        gitService: GitService,
    ): void {
        const fullPath = path.join(repoRoot, filePath);
        const key = `log:${fullPath}`;
        const existing = openPanels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        const label = path.basename(filePath);
        const initState: InitialState = { mode: 'log', targetPath: fullPath, isFile: true };
        const panel = new GitLogPanel(extensionUri, gitService, `Git Log: ${label}`, initState, key);
        panel.repoRoot = repoRoot;
        openPanels.set(key, panel);
    }

    static createBlamePanel(
        extensionUri: vscode.Uri,
        repoRoot: string,
        sha: string,
        filePath: string,
        gitService: GitService,
    ): void {
        const key = `blame:${sha}:${filePath}`;
        const existing = openPanels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        const label = path.basename(filePath);
        const initState: InitialState = { mode: 'blame', blameSha: sha, blameFilePath: filePath };
        const panel = new GitLogPanel(extensionUri, gitService, `Blame: ${label}`, initState, key);
        panel.repoRoot = repoRoot;
        openPanels.set(key, panel);
    }

    private async initRepoRoot(targetPath: string): Promise<void> {
        try {
            const stat = fs.statSync(targetPath);
            const dir = stat.isDirectory() ? targetPath : path.dirname(targetPath);
            this.repoRoot = await this.gitService.getRepoRoot(dir);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.postError(`Failed to find git repository: ${msg}`);
        }
    }

    private async handleMessage(msg: unknown): Promise<void> {
        await this.ready;
        const message = msg as { type: string };
        try {
            switch (message.type) {
                case 'requestCommits':
                    await this.onRequestCommits(msg as RequestCommitsMessage);
                    break;
                case 'requestCommitDetails':
                    await this.onRequestCommitDetails(msg as RequestCommitDetailsMessage);
                    break;
                case 'compareWithPrevious':
                    await this.onCompareWithPrevious(msg as CompareWithPreviousMessage);
                    break;
                case 'compareWithWorkingTree':
                    await this.onCompareWithWorkingTree(msg as CompareWithWorkingTreeMessage);
                    break;
                case 'blame':
                    await this.onBlame(msg as BlameMessage);
                    break;
                case 'compareRevisions':
                    await this.onCompareRevisions(msg as CompareRevisionsMessage);
                    break;
                case 'requestCompareFiles':
                    await this.onRequestCompareFiles();
                    break;
                case 'compareFile':
                    await this.onCompareFile(msg as CompareFileMessage);
                    break;
                case 'showFileLog':
                    await this.onShowFileLog(msg as ShowFileLogMessage);
                    break;
                case 'requestBlameData':
                    await this.onRequestBlameData();
                    break;
            }
        } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.postError(errMsg);
        }
    }

    private async onRequestCommits(msg: RequestCommitsMessage): Promise<void> {
        const targetPath = this.initialState.targetPath || '';
        const relativePath = path.relative(this.repoRoot, targetPath);
        const commits = await this.gitService.getLog(
            this.repoRoot,
            relativePath || '.',
            msg.offset,
            msg.count,
            msg.after,
            msg.before,
        );
        this.panel.webview.postMessage({
            type: 'commitsLoaded',
            commits,
            hasMore: commits.length === msg.count,
        });
    }

    private async onRequestCommitDetails(msg: RequestCommitDetailsMessage): Promise<void> {
        const [detail, files] = await Promise.all([
            this.gitService.getCommitDetail(this.repoRoot, msg.sha),
            this.gitService.getCommitFiles(this.repoRoot, msg.sha),
        ]);
        this.panel.webview.postMessage({
            type: 'commitDetailsLoaded',
            detail,
            files,
        });
    }

    private async onCompareWithPrevious(msg: CompareWithPreviousMessage): Promise<void> {
        let previousSha = msg.previousSha || null;
        if (!previousSha) {
            try {
                previousSha = await this.gitService.getPreviousFileCommit(
                    this.repoRoot, msg.sha, msg.filePath,
                );
            } catch { /* */ }
        }
        await this.openDiff(
            previousSha || msg.sha, msg.sha, msg.filePath, msg.oldPath, msg.status,
        );
    }

    private async onCompareWithWorkingTree(msg: CompareWithWorkingTreeMessage): Promise<void> {
        await this.openDiffWithWorkingTree(msg.sha, msg.filePath, msg.status);
    }

    private async onBlame(msg: BlameMessage): Promise<void> {
        GitLogPanel.createBlamePanel(
            this.extensionUri,
            this.repoRoot,
            msg.sha,
            msg.filePath,
            this.gitService,
        );
    }

    private async onCompareRevisions(msg: CompareRevisionsMessage): Promise<void> {
        if (this.initialState.isFile && this.initialState.targetPath) {
            const filePath = path.relative(this.repoRoot, this.initialState.targetPath);
            await this.openDiff(msg.sha1, msg.sha2, filePath);
            return;
        }
        GitLogPanel.createComparePanel(
            this.extensionUri,
            this.repoRoot,
            msg.sha1,
            msg.sha2,
            this.gitService,
        );
    }

    private async onRequestCompareFiles(): Promise<void> {
        const { sha1, sha2 } = this.initialState;
        if (!sha1 || !sha2) return;
        const [files, detail1, detail2] = await Promise.all([
            this.gitService.getDiffBetween(this.repoRoot, sha1, sha2),
            this.gitService.getCommitDetail(this.repoRoot, sha1),
            this.gitService.getCommitDetail(this.repoRoot, sha2),
        ]);
        this.panel.webview.postMessage({
            type: 'compareFilesLoaded',
            files,
            detail1,
            detail2,
        });
    }

    private async onCompareFile(msg: CompareFileMessage): Promise<void> {
        const { sha1, sha2 } = this.initialState;
        if (!sha1 || !sha2) return;
        await this.openDiff(sha1, sha2, msg.filePath, msg.oldPath, msg.status);
    }

    private async openDiff(
        leftSha: string,
        rightSha: string,
        filePath: string,
        oldPath?: string,
        status?: string,
    ): Promise<void> {
        const leftPath = status === 'R' && oldPath ? oldPath : filePath;
        const leftUri = status === 'A'
            ? vscode.Uri.parse(`${DiffDocProvider.scheme}:empty`)
            : DiffDocProvider.encodeUri(this.repoRoot, leftSha, leftPath);
        const rightUri = status === 'D'
            ? vscode.Uri.parse(`${DiffDocProvider.scheme}:empty`)
            : DiffDocProvider.encodeUri(this.repoRoot, rightSha, filePath);

        const short1 = leftSha.substring(0, 8);
        const short2 = rightSha.substring(0, 8);
        const title = `${path.basename(filePath)} (${short1} ↔ ${short2})`;

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    private async openDiffWithWorkingTree(
        sha: string,
        filePath: string,
        status?: string,
    ): Promise<void> {
        const leftUri = status === 'D'
            ? vscode.Uri.parse(`${DiffDocProvider.scheme}:empty`)
            : DiffDocProvider.encodeUri(this.repoRoot, sha, filePath);
        const rightUri = vscode.Uri.file(path.join(this.repoRoot, filePath));

        const shortSha = sha.substring(0, 8);
        const title = `${path.basename(filePath)} (${shortSha} ↔ Working Tree)`;

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    private async onShowFileLog(msg: ShowFileLogMessage): Promise<void> {
        GitLogPanel.createFileLogPanel(
            this.extensionUri,
            this.repoRoot,
            msg.filePath,
            this.gitService,
        );
    }

    private async onRequestBlameData(): Promise<void> {
        const { blameSha, blameFilePath } = this.initialState;
        if (!blameSha || !blameFilePath) return;

        const blameLines = await this.gitService.blameStructured(this.repoRoot, blameSha, blameFilePath);

        const uniqueShas = [...new Set(blameLines.map(l => l.sha))];
        const detailPromises = uniqueShas.map(sha =>
            this.gitService.getCommitDetail(this.repoRoot, sha),
        );
        const details = await Promise.all(detailPromises);
        const commits: Record<string, CommitDetail> = {};
        for (let i = 0; i < uniqueShas.length; i++) {
            commits[uniqueShas[i]] = details[i];
        }

        this.panel.webview.postMessage({
            type: 'blameDataLoaded',
            lines: blameLines,
            commits,
        });
    }

    private postError(message: string): void {
        this.panel.webview.postMessage({ type: 'error', message });
    }

    private dispose(): void {
        openPanels.delete(this.panelKey);
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private getHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js'),
        );
        const stylesUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'),
        );
        const nonce = getNonce();
        const cspSource = webview.cspSource;

        switch (this.initialState.mode) {
            case 'compare':
                return this.getCompareHtml(scriptUri, stylesUri, nonce, cspSource);
            case 'blame':
                return this.getBlameHtml(scriptUri, stylesUri, nonce, cspSource);
            default:
                return this.getLogHtml(scriptUri, stylesUri, nonce, cspSource);
        }
    }

    private getLogHtml(
        scriptUri: vscode.Uri,
        stylesUri: vscode.Uri,
        nonce: string,
        cspSource: string,
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
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
    <script nonce="${nonce}">var initialState = ${safeJsonStringify(this.initialState)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getCompareHtml(
        scriptUri: vscode.Uri,
        stylesUri: vscode.Uri,
        nonce: string,
        cspSource: string,
    ): string {
        const short1 = this.initialState.sha1?.substring(0, 8) || '';
        const short2 = this.initialState.sha2?.substring(0, 8) || '';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
    <div id="app" class="compare-mode">
        <div id="compare-header" class="compare-header">
            Comparing <span class="detail-sha">${short1}</span> ↔ <span class="detail-sha">${short2}</span>
        </div>
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
    <script nonce="${nonce}">var initialState = ${safeJsonStringify(this.initialState)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getBlameHtml(
        scriptUri: vscode.Uri,
        stylesUri: vscode.Uri,
        nonce: string,
        cspSource: string,
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
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
    <script nonce="${nonce}">var initialState = ${safeJsonStringify(this.initialState)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
