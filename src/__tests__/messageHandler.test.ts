import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createFixtureRepo, FixtureRepo } from './helpers/createFixtureRepo';
import { GitService } from '../gitService';
import { MessageHandler, MessageSender, DiffOpener, PanelCreator, GitActions } from '../messageHandler';
import { InitialState } from '../types';

let repo: FixtureRepo;
let gitService: GitService;

beforeAll(() => {
    repo = createFixtureRepo();
    gitService = new GitService();
}, 30000);

afterAll(() => {
    repo?.cleanup();
});

function createHandler(
    initialState: Partial<InitialState> = {},
    overrides?: { sender?: MessageSender; diffOpener?: DiffOpener; panelCreator?: PanelCreator; gitActions?: GitActions },
) {
    const sender: MessageSender = overrides?.sender || { postMessage: vi.fn() };
    const diffOpener: DiffOpener = overrides?.diffOpener || {
        openDiff: vi.fn(),
        openDiffWithWorkingTree: vi.fn(),
        openFileContents: vi.fn(),
    };
    const panelCreator: PanelCreator = overrides?.panelCreator || {
        createBlamePanel: vi.fn(),
        createComparePanel: vi.fn(),
        createFileLogPanel: vi.fn(),
    };
    const gitActions: GitActions = overrides?.gitActions || {
        cherryPick: vi.fn().mockResolvedValue(true),
        revertCommit: vi.fn().mockResolvedValue(true),
        createBranch: vi.fn().mockResolvedValue(true),
        createTag: vi.fn().mockResolvedValue(true),
    };
    const state: InitialState = {
        mode: 'log',
        targetPath: repo.repoRoot,
        ...initialState,
    };
    const handler = new MessageHandler(gitService, sender, diffOpener, panelCreator, gitActions, repo.repoRoot, state);
    return { handler, sender, diffOpener, panelCreator, gitActions };
}

describe('requestCommits', () => {
    it('posts commitsLoaded with commits', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestCommits', offset: 0, count: 10 });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('commitsLoaded');
        expect(msg.commits).toHaveLength(10);
        expect(msg.hasMore).toBe(true);
    });

    it('sets hasMore false when fewer than count returned', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestCommits', offset: 0, count: 500 });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(msg.hasMore).toBe(false);
        expect(msg.commits.length).toBeLessThan(500);
    });

    it('passes date filters through', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({
            type: 'requestCommits', offset: 0, count: 500,
            after: '2024-01-01T00:00:00', before: '2024-06-30T23:59:59',
        });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(msg.commits.length).toBeGreaterThan(0);
        for (const c of msg.commits) {
            const d = new Date(c.authorDate);
            expect(d.getFullYear()).toBeGreaterThanOrEqual(2024);
        }
    });

    it('excludes commits reachable only from other branches by default', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestCommits', offset: 0, count: 1000 });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const shas = msg.commits.map((c: { hash: string }) => c.hash);
        expect(shas).not.toContain(repo.commits['unmerged-preview']);
    });

    it('includes commits from other branches when branches is "all"', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestCommits', offset: 0, count: 1000, branches: 'all' });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const shas = msg.commits.map((c: { hash: string }) => c.hash);
        expect(shas).toContain(repo.commits['unmerged-preview']);
    });

    it('includes commits from only the explicitly named branches', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({
            type: 'requestCommits', offset: 0, count: 1000, branches: ['experimental/preview'],
        });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const shas = msg.commits.map((c: { hash: string }) => c.hash);
        expect(shas).toContain(repo.commits['unmerged-preview']);
    });
});

describe('requestBranches', () => {
    it('posts branchesLoaded with the repo branches', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestBranches' });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('branchesLoaded');
        for (const b of repo.branches) {
            expect(msg.branches).toContain(b);
        }
    });
});

describe('requestCommits (line history mode)', () => {
    it('serves the -L result on the first request and reports hasMore false', async () => {
        const { handler, sender } = createHandler({
            targetPath: repo.repoRoot + '/src/experimental/revert-target.ts',
            isFile: true,
            lineStart: 1,
            lineEnd: 1,
        });
        await handler.handle({ type: 'requestCommits', offset: 0, count: 100 });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(msg.type).toBe('commitsLoaded');
        expect(msg.hasMore).toBe(false);
        expect(msg.commits.length).toBeGreaterThan(0);
        expect(msg.commits[0].hash).toBe(repo.commits['revert-target-main']);
    });

    it('returns an empty batch for any subsequent offset without re-querying', async () => {
        const { handler, sender } = createHandler({
            targetPath: repo.repoRoot + '/src/experimental/revert-target.ts',
            isFile: true,
            lineStart: 1,
            lineEnd: 1,
        });
        await handler.handle({ type: 'requestCommits', offset: 1, count: 100 });

        const msg = (sender.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(msg.commits).toEqual([]);
        expect(msg.hasMore).toBe(false);
    });
});

describe('requestCommitDetails', () => {
    it('posts commitDetailsLoaded with detail and files', async () => {
        const sha = repo.commits['foundation-0'];
        const { handler, sender } = createHandler();
        await handler.handle({ type: 'requestCommitDetails', sha });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('commitDetailsLoaded');
        expect(msg.detail.hash).toBe(sha);
        expect(msg.detail.authorName).toBe('Alice Anderson');
        expect(msg.files.length).toBeGreaterThan(0);
    });
});

describe('compareWithPrevious', () => {
    it('calls openDiff with previous file commit', async () => {
        const { handler, diffOpener } = createHandler();
        const file = 'src/components/footer.ts';
        const sha = repo.commits['dev-1'] || repo.commits['dev-0'];

        await handler.handle({
            type: 'compareWithPrevious',
            sha,
            filePath: file,
            status: 'M',
        });

        const openDiff = (diffOpener.openDiff as ReturnType<typeof vi.fn>);
        expect(openDiff).toHaveBeenCalledTimes(1);
        const [leftSha, rightSha, filePath] = openDiff.mock.calls[0];
        expect(rightSha).toBe(sha);
        expect(filePath).toBe(file);
        expect(leftSha).not.toBe(sha);
    });

    it('uses provided previousSha when given', async () => {
        const { handler, diffOpener } = createHandler();
        const sha = repo.commits['dev-0'];
        const prevSha = repo.commits['foundation-0'];

        await handler.handle({
            type: 'compareWithPrevious',
            sha,
            previousSha: prevSha,
            filePath: 'src/components/footer.ts',
            status: 'M',
        });

        const openDiff = (diffOpener.openDiff as ReturnType<typeof vi.fn>);
        expect(openDiff.mock.calls[0][0]).toBe(prevSha);
    });
});

describe('compareWithWorkingTree', () => {
    it('calls openDiffWithWorkingTree with the given sha, path, and status', async () => {
        const { handler, diffOpener } = createHandler();
        const file = 'src/components/footer.ts';
        const sha = repo.commits['dev-1'] || repo.commits['dev-0'];

        await handler.handle({
            type: 'compareWithWorkingTree',
            sha,
            filePath: file,
            status: 'M',
        });

        const openDiffWithWorkingTree = (diffOpener.openDiffWithWorkingTree as ReturnType<typeof vi.fn>);
        expect(openDiffWithWorkingTree).toHaveBeenCalledTimes(1);
        expect(openDiffWithWorkingTree).toHaveBeenCalledWith(sha, file, 'M');
    });
});

describe('viewFileContents', () => {
    it('calls openFileContents with the given sha and filePath', async () => {
        const { handler, diffOpener } = createHandler();
        await handler.handle({ type: 'viewFileContents', sha: 'abc123', filePath: 'src/foo.ts' });

        const openFileContents = (diffOpener.openFileContents as ReturnType<typeof vi.fn>);
        expect(openFileContents).toHaveBeenCalledTimes(1);
        expect(openFileContents).toHaveBeenCalledWith('abc123', 'src/foo.ts');
    });
});

describe('blame', () => {
    it('calls createBlamePanel', async () => {
        const { handler, panelCreator } = createHandler();
        await handler.handle({ type: 'blame', sha: 'abc123', filePath: 'src/foo.ts' });

        const create = (panelCreator.createBlamePanel as ReturnType<typeof vi.fn>);
        expect(create).toHaveBeenCalledWith('abc123', 'src/foo.ts');
    });
});

describe('compareRevisions', () => {
    it('creates compare panel for folder log mode', async () => {
        const { handler, panelCreator } = createHandler({ mode: 'log', isFile: false });
        await handler.handle({ type: 'compareRevisions', sha1: 'aaa', sha2: 'bbb' });

        const create = (panelCreator.createComparePanel as ReturnType<typeof vi.fn>);
        expect(create).toHaveBeenCalledWith('aaa', 'bbb');
    });

    it('opens diff directly for file log mode', async () => {
        const targetPath = repo.repoRoot + '/src/components/footer.ts';
        const { handler, diffOpener } = createHandler({ mode: 'log', isFile: true, targetPath });
        await handler.handle({ type: 'compareRevisions', sha1: 'aaa', sha2: 'bbb' });

        const openDiff = (diffOpener.openDiff as ReturnType<typeof vi.fn>);
        expect(openDiff).toHaveBeenCalledTimes(1);
        expect(openDiff.mock.calls[0][0]).toBe('aaa');
        expect(openDiff.mock.calls[0][1]).toBe('bbb');
    });
});

describe('requestCompareFiles', () => {
    it('posts compareFilesLoaded with files and both details', async () => {
        const sha1 = repo.commits['foundation-0'];
        const sha2 = repo.commits['dev-5'] || repo.commits['dev-0'];
        const { handler, sender } = createHandler({ mode: 'compare', sha1, sha2 });
        await handler.handle({ type: 'requestCompareFiles' });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('compareFilesLoaded');
        expect(msg.files.length).toBeGreaterThan(0);
        expect(msg.detail1.hash).toBe(sha1);
        expect(msg.detail2.hash).toBe(sha2);
    });

    it('does nothing when sha1/sha2 missing', async () => {
        const { handler, sender } = createHandler({ mode: 'compare' });
        await handler.handle({ type: 'requestCompareFiles' });

        expect((sender.postMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
});

describe('compareFile', () => {
    it('calls openDiff with sha1 and sha2 from state', async () => {
        const sha1 = repo.commits['foundation-0'];
        const sha2 = repo.commits['dev-0'];
        const { handler, diffOpener } = createHandler({ mode: 'compare', sha1, sha2 });
        await handler.handle({
            type: 'compareFile',
            filePath: 'src/components/footer.ts',
            status: 'M',
        });

        const openDiff = (diffOpener.openDiff as ReturnType<typeof vi.fn>);
        expect(openDiff).toHaveBeenCalledTimes(1);
        expect(openDiff.mock.calls[0][0]).toBe(sha1);
        expect(openDiff.mock.calls[0][1]).toBe(sha2);
    });
});

describe('showFileLog', () => {
    it('calls createFileLogPanel', async () => {
        const { handler, panelCreator } = createHandler();
        await handler.handle({ type: 'showFileLog', filePath: 'src/foo.ts' });

        expect((panelCreator.createFileLogPanel as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('src/foo.ts');
    });
});

describe('requestBlameData', () => {
    it('posts blameDataLoaded with lines and commit details', async () => {
        const file = 'src/components/footer.ts';
        const sha = repo.commits['dev-0'];
        const { handler, sender } = createHandler({
            mode: 'blame', blameSha: sha, blameFilePath: file,
        });
        await handler.handle({ type: 'requestBlameData' });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('blameDataLoaded');
        expect(msg.lines.length).toBeGreaterThan(0);
        expect(Object.keys(msg.commits).length).toBeGreaterThan(0);
    });

    it('does nothing when blame sha/file missing', async () => {
        const { handler, sender } = createHandler({ mode: 'blame' });
        await handler.handle({ type: 'requestBlameData' });

        expect((sender.postMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
});

describe('cherryPick', () => {
    it('delegates to gitActions and posts gitActionCompleted when it succeeds', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn().mockResolvedValue(true),
            revertCommit: vi.fn(),
            createBranch: vi.fn(),
            createTag: vi.fn(),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'cherryPick', sha: 'abc123' });

        expect(gitActions.cherryPick).toHaveBeenCalledWith('abc123');
        expect(sender.postMessage).toHaveBeenCalledWith({ type: 'gitActionCompleted' });
    });

    it('does not post gitActionCompleted when cancelled or failed', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn().mockResolvedValue(false),
            revertCommit: vi.fn(),
            createBranch: vi.fn(),
            createTag: vi.fn(),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'cherryPick', sha: 'abc123' });

        expect(sender.postMessage).not.toHaveBeenCalled();
    });
});

describe('revertCommit', () => {
    it('delegates to gitActions and posts gitActionCompleted when it succeeds', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn(),
            revertCommit: vi.fn().mockResolvedValue(true),
            createBranch: vi.fn(),
            createTag: vi.fn(),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'revertCommit', sha: 'def456' });

        expect(gitActions.revertCommit).toHaveBeenCalledWith('def456');
        expect(sender.postMessage).toHaveBeenCalledWith({ type: 'gitActionCompleted' });
    });
});

describe('createBranch', () => {
    it('delegates to gitActions and posts gitActionCompleted when it succeeds', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn(),
            revertCommit: vi.fn(),
            createBranch: vi.fn().mockResolvedValue(true),
            createTag: vi.fn(),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'createBranch', sha: 'aaa111' });

        expect(gitActions.createBranch).toHaveBeenCalledWith('aaa111');
        expect(sender.postMessage).toHaveBeenCalledWith({ type: 'gitActionCompleted' });
    });

    it('does not post gitActionCompleted when the input box is cancelled', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn(),
            revertCommit: vi.fn(),
            createBranch: vi.fn().mockResolvedValue(false),
            createTag: vi.fn(),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'createBranch', sha: 'aaa111' });

        expect(sender.postMessage).not.toHaveBeenCalled();
    });
});

describe('createTag', () => {
    it('delegates to gitActions and posts gitActionCompleted when it succeeds', async () => {
        const gitActions: GitActions = {
            cherryPick: vi.fn(),
            revertCommit: vi.fn(),
            createBranch: vi.fn(),
            createTag: vi.fn().mockResolvedValue(true),
        };
        const { handler, sender } = createHandler({}, { gitActions });
        await handler.handle({ type: 'createTag', sha: 'bbb222' });

        expect(gitActions.createTag).toHaveBeenCalledWith('bbb222');
        expect(sender.postMessage).toHaveBeenCalledWith({ type: 'gitActionCompleted' });
    });
});

describe('error handling', () => {
    it('posts error message on handler failure', async () => {
        const { handler, sender } = createHandler();
        await handler.handle({
            type: 'requestCommitDetails',
            sha: 'nonexistent-sha-that-will-fail',
        });

        const post = (sender.postMessage as ReturnType<typeof vi.fn>);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0];
        expect(msg.type).toBe('error');
        expect(msg.message.length).toBeGreaterThan(0);
    });
});
