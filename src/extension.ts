import * as vscode from 'vscode';
import * as path from 'path';
import { GitLogPanel } from './gitLogPanel';
import { DiffDocProvider } from './diffDocProvider';
import { GitService } from './gitService';

type CommandArg = vscode.Uri | { resourceUri?: vscode.Uri } | { rootUri?: vscode.Uri };

// install.sh renames every "gitLogViewer.*" id in package.json's
// contributes.commands/menus/keybindings to "gitLogViewerDev.*" (plus a
// " (Dev)" title suffix) when building a local side-loadable copy, so it
// can be installed alongside the real Marketplace extension without
// command-id collisions - but it can only rewrite the manifest, not this
// file, so whatever a keybinding or menu item ends up calling in a dev
// build still has to actually be registered here under that exact
// "gitLogViewerDev.*" id. Registering through this helper instead of two
// separate vscode.commands.registerCommand calls makes that automatic for
// every command, current and future, rather than something each one has
// to separately remember - this already silently broke once before for
// showLineHistory (see install.sh's own comment on its rename function),
// and again for refresh/showRepoLog when they were added without it.
function registerDualCommand(
    context: vscode.ExtensionContext,
    suffix: string,
    handler: (...args: never[]) => unknown,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(`gitLogViewer.${suffix}`, handler),
        vscode.commands.registerCommand(`gitLogViewerDev.${suffix}`, handler),
    );
}

export function activate(context: vscode.ExtensionContext) {
    const gitService = new GitService();
    const diffProvider = new DiffDocProvider(gitService);

    const handler = (arg?: CommandArg) => {
        const target = (arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri })?.resourceUri)
            || (arg as { rootUri?: vscode.Uri })?.rootUri
            || vscode.window.activeTextEditor?.document.uri;
        if (!target) {
            return;
        }
        GitLogPanel.createLogPanel(
            context.extensionUri,
            target.fsPath,
            gitService,
        );
    };

    // In a single-folder workspace (the common case), the repo root has no
    // right-clickable row in the Explorer at all - it's only shown as the
    // panel's own title text, so explorer/context (which only ever fires on
    // an actual tree item) can never reach it. A multi-root workspace does
    // show each root as its own row with a working right-click already (the
    // handler above resolves it via resourceUri there), so this exists
    // specifically to cover the single-folder gap. VS Code has no supported
    // way to contribute a button into the built-in Explorer's own title bar
    // (a standing feature request - microsoft/vscode#108271 - never
    // shipped; contributes.menus["view/title"] silently does nothing for
    // workbench.explorer.fileView, confirmed live), so this is reachable
    // via the Command Palette and the status bar item set up below instead.
    const showRepoLogHandler = async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }
        const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (!folder) {
            return;
        }
        GitLogPanel.createLogPanel(
            context.extensionUri,
            folder.uri.fsPath,
            gitService,
        );
    };

    const lineHistoryHandler = async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        const uri = editor.document.uri;
        const lineStart = editor.selection.start.line + 1;
        const lineEnd = editor.selection.end.line + 1;
        let repoRoot: string;
        try {
            repoRoot = await gitService.getRepoRoot(path.dirname(uri.fsPath));
        } catch {
            return;
        }
        const relativePath = path.relative(repoRoot, uri.fsPath);
        GitLogPanel.createLineHistoryPanel(
            context.extensionUri,
            repoRoot,
            relativePath,
            lineStart,
            lineEnd,
            gitService,
        );
    };

    // Always-visible, one-click way to reach the repo root's log regardless
    // of which panel is focused (Explorer, an editor, Source Control, ...) -
    // the actual fix for the single-folder Explorer gap described above,
    // since a status bar item is the standard, VS Code-supported
    // alternative to a (non-existent) Explorer title-bar button. Shown
    // whenever a workspace folder is open; showRepoLogHandler itself
    // degrades gracefully (via GitLogPanel's existing postError path) if
    // that folder turns out not to be a git repo, so this doesn't need to
    // duplicate the config.git.enabled/gitOpenRepositoryCount checks the
    // static menu contributions use.
    const repoLogStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    repoLogStatusBarItem.text = '$(git-commit) Git Log';
    repoLogStatusBarItem.tooltip = 'Show Git Log for Repository Root';
    repoLogStatusBarItem.command = 'gitLogViewer.showRepoLog';
    if (vscode.workspace.workspaceFolders?.length) {
        repoLogStatusBarItem.show();
    }

    registerDualCommand(context, 'showLog', handler);
    registerDualCommand(context, 'showLineHistory', lineHistoryHandler);
    registerDualCommand(context, 'refresh', () => GitLogPanel.refreshActivePanel());
    registerDualCommand(context, 'showRepoLog', showRepoLogHandler);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffDocProvider.scheme,
            diffProvider,
        ),
        repoLogStatusBarItem,
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (vscode.workspace.workspaceFolders?.length) {
                repoLogStatusBarItem.show();
            } else {
                repoLogStatusBarItem.hide();
            }
        }),
    );
}

export function deactivate() {}
