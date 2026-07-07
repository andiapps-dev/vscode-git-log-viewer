import * as vscode from 'vscode';
import { GitLogPanel } from './gitLogPanel';
import { DiffDocProvider } from './diffDocProvider';
import { GitService } from './gitService';

export function activate(context: vscode.ExtensionContext) {
    const gitService = new GitService();
    const diffProvider = new DiffDocProvider(gitService);

    const handler = (arg?: vscode.Uri | { resourceUri?: vscode.Uri }) => {
        const target = (arg instanceof vscode.Uri ? arg : arg?.resourceUri)
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

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffDocProvider.scheme,
            diffProvider,
        ),
        vscode.commands.registerCommand('gitLogViewer.showLog', handler),
        vscode.commands.registerCommand('gitLogViewerDev.showLog', handler),
    );
}

export function deactivate() {}
