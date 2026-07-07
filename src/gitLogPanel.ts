import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from './gitService';
import { DiffDocProvider } from './diffDocProvider';
import { safeJsonStringify } from './utils';
import { MessageHandler } from './messageHandler';
import { InitialState } from './types';

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
        await this.getMessageHandler().handle(msg);
    }

    private messageHandler?: MessageHandler;

    private getMessageHandler(): MessageHandler {
        if (!this.messageHandler) {
            this.messageHandler = new MessageHandler(
                this.gitService,
                { postMessage: msg => { this.panel.webview.postMessage(msg); } },
                {
                    openDiff: (leftSha, rightSha, filePath, oldPath, status) =>
                        this.openDiff(leftSha, rightSha, filePath, oldPath, status),
                    openDiffWithWorkingTree: (sha, filePath, status) =>
                        this.openDiffWithWorkingTree(sha, filePath, status),
                },
                {
                    createBlamePanel: (sha, filePath) =>
                        GitLogPanel.createBlamePanel(this.extensionUri, this.repoRoot, sha, filePath, this.gitService),
                    createComparePanel: (sha1, sha2) =>
                        GitLogPanel.createComparePanel(this.extensionUri, this.repoRoot, sha1, sha2, this.gitService),
                    createFileLogPanel: filePath =>
                        GitLogPanel.createFileLogPanel(this.extensionUri, this.repoRoot, filePath, this.gitService),
                },
                this.repoRoot,
                this.initialState,
            );
        }
        return this.messageHandler;
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
