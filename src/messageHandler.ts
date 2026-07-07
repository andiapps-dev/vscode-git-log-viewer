import * as path from 'path';
import { GitService } from './gitService';
import {
    InitialState,
    CommitDetail,
    RequestCommitsMessage,
    RequestCommitDetailsMessage,
    CompareWithPreviousMessage,
    CompareWithWorkingTreeMessage,
    CompareFileMessage,
} from './types';

export interface MessageSender {
    postMessage(msg: unknown): void;
}

export interface DiffOpener {
    openDiff(leftSha: string, rightSha: string, filePath: string, oldPath?: string, status?: string): Promise<void>;
    openDiffWithWorkingTree(sha: string, filePath: string, status?: string): Promise<void>;
}

export interface PanelCreator {
    createBlamePanel(sha: string, filePath: string): void;
    createComparePanel(sha1: string, sha2: string): void;
    createFileLogPanel(filePath: string): void;
}

export class MessageHandler {
    constructor(
        private gitService: GitService,
        private sender: MessageSender,
        private diffOpener: DiffOpener,
        private panelCreator: PanelCreator,
        private repoRoot: string,
        private initialState: InitialState,
    ) {}

    async handle(msg: unknown): Promise<void> {
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
                    await this.onBlame(msg as { sha: string; filePath: string });
                    break;
                case 'compareRevisions':
                    await this.onCompareRevisions(msg as { sha1: string; sha2: string });
                    break;
                case 'requestCompareFiles':
                    await this.onRequestCompareFiles();
                    break;
                case 'compareFile':
                    await this.onCompareFile(msg as CompareFileMessage);
                    break;
                case 'showFileLog':
                    await this.onShowFileLog(msg as { filePath: string });
                    break;
                case 'requestBlameData':
                    await this.onRequestBlameData();
                    break;
            }
        } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.sender.postMessage({ type: 'error', message: errMsg });
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
            this.initialState.isFile,
        );
        this.sender.postMessage({
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
        this.sender.postMessage({
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
        await this.diffOpener.openDiff(
            previousSha || msg.sha, msg.sha, msg.filePath, msg.oldPath, msg.status,
        );
    }

    private async onCompareWithWorkingTree(msg: CompareWithWorkingTreeMessage): Promise<void> {
        await this.diffOpener.openDiffWithWorkingTree(msg.sha, msg.filePath, msg.status);
    }

    private async onBlame(msg: { sha: string; filePath: string }): Promise<void> {
        this.panelCreator.createBlamePanel(msg.sha, msg.filePath);
    }

    private async onCompareRevisions(msg: { sha1: string; sha2: string }): Promise<void> {
        if (this.initialState.isFile && this.initialState.targetPath) {
            const filePath = path.relative(this.repoRoot, this.initialState.targetPath);
            await this.diffOpener.openDiff(msg.sha1, msg.sha2, filePath);
            return;
        }
        this.panelCreator.createComparePanel(msg.sha1, msg.sha2);
    }

    private async onRequestCompareFiles(): Promise<void> {
        const { sha1, sha2 } = this.initialState;
        if (!sha1 || !sha2) return;
        const [files, detail1, detail2] = await Promise.all([
            this.gitService.getDiffBetween(this.repoRoot, sha1, sha2),
            this.gitService.getCommitDetail(this.repoRoot, sha1),
            this.gitService.getCommitDetail(this.repoRoot, sha2),
        ]);
        this.sender.postMessage({
            type: 'compareFilesLoaded',
            files,
            detail1,
            detail2,
        });
    }

    private async onCompareFile(msg: CompareFileMessage): Promise<void> {
        const { sha1, sha2 } = this.initialState;
        if (!sha1 || !sha2) return;
        await this.diffOpener.openDiff(sha1, sha2, msg.filePath, msg.oldPath, msg.status);
    }

    private async onShowFileLog(msg: { filePath: string }): Promise<void> {
        this.panelCreator.createFileLogPanel(msg.filePath);
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

        this.sender.postMessage({
            type: 'blameDataLoaded',
            lines: blameLines,
            commits,
        });
    }
}
