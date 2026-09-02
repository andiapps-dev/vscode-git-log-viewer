import * as path from 'path';
import { GitService } from './gitService';
import {
    InitialState,
    Commit,
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
    openFileContents(sha: string, filePath: string): Promise<void>;
}

export interface PanelCreator {
    createBlamePanel(sha: string, filePath: string): void;
    createComparePanel(sha1: string, sha2: string): void;
    createFileLogPanel(filePath: string): void;
}

export class MessageHandler {
    // How many unscoped commits to fetch for the commit-graph's supporting
    // ancestry data (see onRequestCommits) - generous enough to connect
    // most real path-scoped gaps, bounded so it doesn't walk an entire
    // large repo's history unbounded for a rarely-touched file.
    private static readonly GRAPH_EDGES_FETCH_COUNT = 3000;

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
                case 'requestBranches':
                    await this.onRequestBranches();
                    break;
                case 'requestCommitRefs':
                    await this.onRequestCommitRefs(msg as { sha: string });
                    break;
                case 'viewFileContents':
                    await this.onViewFileContents(msg as { sha: string; filePath: string });
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
        const { lineStart, lineEnd } = this.initialState;

        if (lineStart && lineEnd) {
            // -L walks the whole history of the range in one shot; there's no
            // --skip/-N pagination for it, so only serve the first request.
            if (msg.offset > 0) {
                this.sender.postMessage({ type: 'commitsLoaded', commits: [], hasMore: false });
                return;
            }
            const commits = await this.gitService.getLineHistory(
                this.repoRoot, relativePath, lineStart, lineEnd, msg.after, msg.before,
            );
            this.sender.postMessage({ type: 'commitsLoaded', commits, hasMore: false });
            return;
        }

        const targetIsScoped = !!relativePath && relativePath !== '.';
        const commits = await this.gitService.getLog(
            this.repoRoot,
            relativePath || '.',
            msg.offset,
            msg.count,
            msg.after,
            msg.before,
            this.initialState.isFile,
            msg.branches,
        );

        // A path-scoped query (File Log, Folder View) never returns commits
        // that didn't touch that path - even though they can be real
        // intermediate parents of ones that did (git's history
        // simplification only affects which commits get *returned*, never
        // what a returned commit's own %P is). The commit graph needs that
        // missing ancestry to connect around them, so fetch it separately,
        // unscoped, from the same branches/date range. Bounded rather than
        // walking the whole repo, and only on the first page - later pages
        // degrade gracefully (an unresolved gap just shows as a dangling
        // line, not an error) rather than growing this fetch without bound
        // as more of a very deep, rarely-touched file's history loads.
        let graphEdges: Commit[] | undefined;
        if (targetIsScoped && msg.offset === 0) {
            graphEdges = await this.gitService.getLog(
                this.repoRoot,
                '.',
                0,
                MessageHandler.GRAPH_EDGES_FETCH_COUNT,
                msg.after,
                msg.before,
                false,
                msg.branches,
            );
        }

        this.sender.postMessage({
            type: 'commitsLoaded',
            commits,
            hasMore: commits.length === msg.count,
            ...(graphEdges ? { graphEdges } : {}),
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

    private async onRequestBranches(): Promise<void> {
        const branches = await this.gitService.listBranches(this.repoRoot);
        this.sender.postMessage({ type: 'branchesLoaded', branches });
    }

    private async onRequestCommitRefs(msg: { sha: string }): Promise<void> {
        const { branches, tags } = await this.gitService.getContainingRefs(this.repoRoot, msg.sha);
        this.sender.postMessage({ type: 'commitRefsLoaded', sha: msg.sha, branches, tags });
    }

    private async onViewFileContents(msg: { sha: string; filePath: string }): Promise<void> {
        await this.diffOpener.openFileContents(msg.sha, msg.filePath);
    }
}
