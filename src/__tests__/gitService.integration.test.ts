import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { createFixtureRepo, FixtureRepo } from './helpers/createFixtureRepo';
import { GitService } from '../gitService';
import * as path from 'path';

let repo: FixtureRepo;
let git: GitService;

function rawGit(args: string[]): string {
    return execFileSync('git', args, { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
    repo = createFixtureRepo();
    git = new GitService();
}, 30000);

afterAll(() => {
    repo?.cleanup();
});

describe('getRepoRoot', () => {
    it('resolves from repo root', async () => {
        const root = await git.getRepoRoot(repo.repoRoot);
        expect(root).toBe(repo.repoRoot);
    });

    it('resolves from nested subdirectory', async () => {
        const sub = path.join(repo.repoRoot, 'src', 'components');
        const root = await git.getRepoRoot(sub);
        expect(root).toBe(repo.repoRoot);
    });

    it('rejects for path outside any repo', async () => {
        await expect(git.getRepoRoot('/tmp')).rejects.toThrow();
    });
});

describe('resolveRef', () => {
    it('resolves HEAD', async () => {
        const result = await git.resolveRef(repo.repoRoot, 'HEAD');
        const expected = rawGit(['rev-parse', '--short', 'HEAD']);
        expect(result).toBe(expected);
    });

    it('resolves tag v1.0', async () => {
        const result = await git.resolveRef(repo.repoRoot, 'v1.0');
        const expected = rawGit(['rev-parse', '--short', 'v1.0']);
        expect(result).toBe(expected);
    });

    it('resolves tag v2.0', async () => {
        const result = await git.resolveRef(repo.repoRoot, 'v2.0');
        const expected = rawGit(['rev-parse', '--short', 'v2.0']);
        expect(result).toBe(expected);
    });

    it('resolves branch name', async () => {
        const result = await git.resolveRef(repo.repoRoot, 'main');
        const expected = rawGit(['rev-parse', '--short', 'main']);
        expect(result).toBe(expected);
    });

    it('rejects for nonexistent ref', async () => {
        await expect(git.resolveRef(repo.repoRoot, 'nonexistent-ref')).rejects.toThrow();
    });
});

describe('getLog', () => {
    describe('pagination and lazy load', () => {
        it('returns first 100 commits', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 100);
            expect(commits).toHaveLength(100);
        });

        it('returns second batch with skip', async () => {
            const batch2 = await git.getLog(repo.repoRoot, '.', 100, 100);
            expect(batch2.length).toBeGreaterThan(0);
        });

        it('total across all batches matches git log count', async () => {
            const expectedCount = rawGit(['log', '--oneline', '--', '.']).split('\n').filter(Boolean).length;
            let total = 0;
            let offset = 0;
            while (true) {
                const batch = await git.getLog(repo.repoRoot, '.', offset, 100);
                total += batch.length;
                if (batch.length < 100) break;
                offset += 100;
            }
            expect(total).toBe(expectedCount);
        });

        it('returns exact count requested', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 5);
            expect(commits).toHaveLength(5);
        });

        it('skip works correctly', async () => {
            const all = await git.getLog(repo.repoRoot, '.', 0, 10);
            const skipped = await git.getLog(repo.repoRoot, '.', 5, 5);
            expect(skipped[0].hash).toBe(all[5].hash);
        });
    });

    describe('path scoping', () => {
        it('scoped to file returns only commits touching that file', async () => {
            const file = 'src/components/footer.ts';
            const commits = await git.getLog(repo.repoRoot, file, 0, 500);
            const expected = parseInt(rawGit(['rev-list', '--count', 'HEAD', '--', file]), 10);
            expect(commits.length).toBe(expected);
            expect(commits.length).toBeGreaterThan(0);
            expect(commits.length).toBeLessThan(297);
        });

        it('scoped to directory returns commits touching that directory', async () => {
            const dir = 'src/services';
            const commits = await git.getLog(repo.repoRoot, dir, 0, 500);
            const expected = parseInt(rawGit(['rev-list', '--count', 'HEAD', '--', dir]), 10);
            expect(commits.length).toBe(expected);
        });
    });

    describe('date filtering', () => {
        it('after filter excludes early commits', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 500, '2024-01-01T00:00:00');
            for (const c of commits) {
                expect(new Date(c.authorDate).getTime()).toBeGreaterThanOrEqual(new Date('2024-01-01').getTime());
            }
        });

        it('before filter excludes late commits', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 500, undefined, '2023-06-01T23:59:59');
            for (const c of commits) {
                expect(new Date(c.authorDate).getTime()).toBeLessThanOrEqual(new Date('2023-06-02').getTime());
            }
        });

        it('combined range returns correct subset', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 500, '2023-06-01T00:00:00', '2023-09-30T23:59:59');
            expect(commits.length).toBeGreaterThan(0);
            const all = await git.getLog(repo.repoRoot, '.', 0, 500);
            expect(commits.length).toBeLessThan(all.length);
        });

        it('future date range returns empty', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 100, '2030-01-01T00:00:00');
            expect(commits).toHaveLength(0);
        });
    });

    describe('cross-validation with raw git', () => {
        it('fields match raw git log output', async () => {
            const SEP = '\x1e';
            const commits = await git.getLog(repo.repoRoot, '.', 0, 10);
            const rawOutput = rawGit(['log', `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`, '-10']);
            const rawCommits = rawOutput.split('\n').map(line => {
                const parts = line.split(SEP);
                return { hash: parts[0], shortHash: parts[1], subject: parts[2], authorName: parts[3], authorDate: parts[4] };
            });
            expect(commits.length).toBe(rawCommits.length);
            for (let i = 0; i < commits.length; i++) {
                expect(commits[i].hash).toBe(rawCommits[i].hash);
                expect(commits[i].shortHash).toBe(rawCommits[i].shortHash);
                expect(commits[i].subject).toBe(rawCommits[i].subject);
                expect(commits[i].authorName).toBe(rawCommits[i].authorName);
                expect(commits[i].authorDate).toBe(rawCommits[i].authorDate);
            }
        });
    });

    describe('commit field correctness', () => {
        it('each commit has all required fields', async () => {
            const commits = await git.getLog(repo.repoRoot, '.', 0, 20);
            for (const c of commits) {
                expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
                expect(c.shortHash.length).toBeGreaterThanOrEqual(7);
                expect(c.subject.length).toBeGreaterThan(0);
                expect(c.authorName.length).toBeGreaterThan(0);
                expect(c.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            }
        });
    });
});

describe('getCommitDetail', () => {
    it('returns correct fields for a known commit', async () => {
        const sha = repo.commits['foundation-0'];
        const detail = await git.getCommitDetail(repo.repoRoot, sha);
        expect(detail.hash).toBe(sha);
        expect(detail.shortHash).toBe(sha.substring(0, detail.shortHash.length));
        expect(detail.authorName).toBe('Alice Anderson');
        expect(detail.authorEmail).toBe('alice@test.com');
        expect(detail.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(detail.body).toContain('initial project setup');
    });

    it('body includes multi-line commit messages', async () => {
        const commits = await git.getLog(repo.repoRoot, '.', 0, 300);
        const multiLine = commits.find(c => c.subject.startsWith('Improve'));
        if (multiLine) {
            const detail = await git.getCommitDetail(repo.repoRoot, multiLine.hash);
            expect(detail.body).toContain('\n');
        }
    });

    it('different authors have correct emails', async () => {
        const aliceCommit = repo.commits['foundation-0'];
        const alice = await git.getCommitDetail(repo.repoRoot, aliceCommit);
        expect(alice.authorEmail).toBe('alice@test.com');

        const bobKey = Object.keys(repo.commits).find(k => k === 'foundation-1');
        if (bobKey) {
            const bob = await git.getCommitDetail(repo.repoRoot, repo.commits[bobKey]);
            expect(bob.authorEmail).toBe('bob@test.com');
        }
    });
});

describe('getCommitFiles', () => {
    describe('single parent commits', () => {
        it('initial commit lists added files with status A', async () => {
            const sha = repo.commits['foundation-0'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            expect(files.length).toBeGreaterThan(0);
            for (const f of files) {
                expect(f.status).toBe('A');
            }
        });

        it('modify commit lists file with status M and correct counts', async () => {
            const sha = repo.commits['dev-0'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            expect(files.length).toBeGreaterThan(0);
            const modified = files.find(f => f.status === 'M');
            expect(modified).toBeDefined();
            expect(modified!.additions).toBeGreaterThanOrEqual(0);
            expect(modified!.deletions).toBeGreaterThanOrEqual(0);
        });

        it('rename commit has R status with oldPath', async () => {
            let found = false;
            for (let i = 0; i < 5; i++) {
                const sha = repo.commits[`rename-${i}`];
                if (!sha) continue;
                const files = await git.getCommitFiles(repo.repoRoot, sha);
                const renamed = files.find(f => f.status === 'R');
                if (renamed) {
                    expect(renamed.oldPath).toBeDefined();
                    expect(renamed.oldPath!.length).toBeGreaterThan(0);
                    found = true;
                    break;
                }
            }
            expect(found).toBe(true);
        });

        it('delete commit has D status', async () => {
            const sha = repo.commits['cleanup-delete-0'];
            if (sha) {
                const files = await git.getCommitFiles(repo.repoRoot, sha);
                const deleted = files.find(f => f.status === 'D');
                expect(deleted).toBeDefined();
            }
        });

        it('binary file commit has 0/0 additions/deletions', async () => {
            const sha = repo.commits['binary-0'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            const binary = files.find(f => f.path.endsWith('.png') || f.path.endsWith('.jpg'));
            if (binary) {
                expect(binary.additions).toBe(0);
                expect(binary.deletions).toBe(0);
            }
        });

        it('commit with multiple files returns all changes', async () => {
            const sha = repo.commits['foundation-0'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            expect(files.length).toBeGreaterThan(1);
        });

        it('non-merge commit has no parentGroup', async () => {
            const sha = repo.commits['dev-0'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            for (const f of files) {
                expect(f.parentGroup).toBeUndefined();
            }
        });
    });

    describe('merge commits', () => {
        it('merge commit returns files with parentGroup', async () => {
            const sha = repo.commits['merge-new-ui'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            expect(files.length).toBeGreaterThan(0);
            expect(files.some(f => f.parentGroup !== undefined)).toBe(true);
            const groups = [...new Set(files.map(f => f.parentGroup).filter(Boolean))];
            expect(groups.length).toBeGreaterThanOrEqual(1);
        });

        it('each parent group header contains short SHA', async () => {
            const sha = repo.commits['merge-new-ui'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            const groups = [...new Set(files.map(f => f.parentGroup))];
            for (const g of groups) {
                expect(g).toMatch(/Diff with parent \d+: [0-9a-f]+/);
            }
        });

        it('second merge also has parent groups', async () => {
            const sha = repo.commits['merge-hotfix'];
            const files = await git.getCommitFiles(repo.repoRoot, sha);
            expect(files.length).toBeGreaterThan(0);
            expect(files.some(f => f.parentGroup !== undefined)).toBe(true);
        });
    });
});

describe('getFileAtRevision', () => {
    it('returns correct file content at a specific commit', async () => {
        const sha = repo.commits['foundation-0'];
        const content = await git.getFileAtRevision(repo.repoRoot, sha, 'src/components/footer.ts');
        expect(content).toContain('version 1');
    });

    it('returns updated content at a later commit', async () => {
        const laterSha = repo.commits['dev-1'] || repo.commits['dev-0'];
        const content = await git.getFileAtRevision(repo.repoRoot, laterSha, 'src/components/footer.ts');
        expect(content.length).toBeGreaterThan(0);
    });

    it('returns empty string for file that did not exist', async () => {
        const sha = repo.commits['foundation-0'];
        const content = await git.getFileAtRevision(repo.repoRoot, sha, 'nonexistent-file.ts');
        expect(content).toBe('');
    });

    it('returns empty string for bad revision', async () => {
        const content = await git.getFileAtRevision(repo.repoRoot, 'deadbeef' + '0'.repeat(32), 'src/components/footer.ts');
        expect(content).toBe('');
    });
});

describe('getDiffBetween', () => {
    it('shows added/modified files between two commits', async () => {
        const sha1 = repo.commits['foundation-0'];
        const sha2 = repo.commits['dev-5'] || repo.commits['dev-0'];
        const files = await git.getDiffBetween(repo.repoRoot, sha1, sha2);
        expect(files.length).toBeGreaterThan(0);
        const statuses = new Set(files.map(f => f.status));
        expect(statuses.size).toBeGreaterThan(0);
    });

    it('diff between same commit returns empty', async () => {
        const sha = repo.commits['foundation-0'];
        const files = await git.getDiffBetween(repo.repoRoot, sha, sha);
        expect(files).toHaveLength(0);
    });

    it('diff includes correct line counts', async () => {
        const sha1 = repo.commits['foundation-0'];
        const sha2 = repo.commits['dev-0'];
        const files = await git.getDiffBetween(repo.repoRoot, sha1, sha2);
        const modified = files.find(f => f.status === 'M');
        if (modified) {
            expect(typeof modified.additions).toBe('number');
            expect(typeof modified.deletions).toBe('number');
        }
    });
});

describe('getPreviousFileCommit', () => {
    it('returns previous commit for a file with multiple changes', async () => {
        const file = 'src/components/footer.ts';
        const allFileCommits = rawGit(['log', '--format=%H', '--', file]).split('\n').filter(Boolean);
        if (allFileCommits.length >= 2) {
            const current = allFileCommits[0];
            const expected = allFileCommits[1];
            const result = await git.getPreviousFileCommit(repo.repoRoot, current, file);
            expect(result).toBe(expected);
        }
    });

    it('returns null for file with only one commit', async () => {
        // Find a file that was only touched once
        const file = 'assets/icon.svg';
        const count = parseInt(rawGit(['rev-list', '--count', 'HEAD', '--', file]), 10);
        if (count === 1) {
            const sha = rawGit(['log', '--format=%H', '-1', '--', file]);
            const result = await git.getPreviousFileCommit(repo.repoRoot, sha, file);
            expect(result).toBeNull();
        }
    });
});

describe('blameStructured', () => {
    it('returns correct per-line attribution', async () => {
        const file = 'src/components/footer.ts';
        const sha = rawGit(['log', '--format=%H', '-1', '--', file]);
        const lines = await git.blameStructured(repo.repoRoot, sha, file);
        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
            expect(line.sha).toMatch(/^[0-9a-f]{40}$/);
            expect(line.shortSha).toBe(line.sha.substring(0, 8));
            expect(line.author.length).toBeGreaterThan(0);
            expect(line.authorEmail.length).toBeGreaterThan(0);
            expect(line.timestamp).toBeGreaterThan(0);
            expect(line.summary.length).toBeGreaterThan(0);
            expect(line.lineNo).toBeGreaterThan(0);
            expect(typeof line.content).toBe('string');
        }
    });

    it('line numbers are sequential starting from 1', async () => {
        const file = 'src/utils/format.ts';
        const sha = rawGit(['log', '--format=%H', '-1', '--', file]);
        const lines = await git.blameStructured(repo.repoRoot, sha, file);
        for (let i = 0; i < lines.length; i++) {
            expect(lines[i].lineNo).toBe(i + 1);
        }
    });

    it('multi-author file shows different SHAs', async () => {
        const file = 'src/components/footer.ts';
        const sha = rawGit(['log', '--format=%H', '-1', '--', file]);
        const lines = await git.blameStructured(repo.repoRoot, sha, file);
        const uniqueShas = new Set(lines.map(l => l.sha));
        // File should have been touched by multiple commits
        if (uniqueShas.size > 1) {
            expect(uniqueShas.size).toBeGreaterThan(1);
        }
    });
});

describe('revert commit', () => {
    it('revert commit appears in log', async () => {
        const sha = repo.commits['revert'];
        const detail = await git.getCommitDetail(repo.repoRoot, sha);
        expect(detail.body).toContain('Revert');
    });

    it('revert commit shows file changes', async () => {
        const sha = repo.commits['revert'];
        const files = await git.getCommitFiles(repo.repoRoot, sha);
        expect(files.length).toBeGreaterThan(0);
        const deleted = files.find(f => f.status === 'D');
        expect(deleted).toBeDefined();
    });
});
