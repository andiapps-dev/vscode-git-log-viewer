import * as vscode from 'vscode';
import * as path from 'path';
import { GitLogPanel } from './gitLogPanel';
import { DiffDocProvider } from './diffDocProvider';
import { GitService } from './gitService';

type CommandArg = vscode.Uri | { resourceUri?: vscode.Uri } | { rootUri?: vscode.Uri };

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

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffDocProvider.scheme,
            diffProvider,
        ),
        vscode.commands.registerCommand('gitLogViewer.showLog', handler),
        vscode.commands.registerCommand('gitLogViewerDev.showLog', handler),
        vscode.commands.registerCommand('gitLogViewer.showLineHistory', lineHistoryHandler),
    );
}

export function deactivate() {}
