import { describe, it, expect } from 'vitest';
import {
    parseStatusAndNumstat,
    parseLogOutput,
    parseCommitDetail,
    parseBlameOutput,
} from '../gitService';

const SEP = '\x1e';

describe('parseLogOutput', () => {
    it('parses standard log output', () => {
        const out = [
            `abc123${SEP}abc1234${SEP}Fix bug${SEP}Alice${SEP}2026-06-17T10:00:00-04:00`,
            `def456${SEP}def4567${SEP}Add feature${SEP}Bob${SEP}2026-06-16T09:00:00-04:00`,
        ].join('\n');

        const result = parseLogOutput(out);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            hash: 'abc123',
            shortHash: 'abc1234',
            subject: 'Fix bug',
            authorName: 'Alice',
            authorDate: '2026-06-17T10:00:00-04:00',
        });
        expect(result[1].authorName).toBe('Bob');
    });

    it('returns empty array for empty output', () => {
        expect(parseLogOutput('')).toEqual([]);
        expect(parseLogOutput('  \n  ')).toEqual([]);
    });

    it('handles subjects with special characters', () => {
        const out = `abc${SEP}abc${SEP}Fix "quotes" & <tags>${SEP}Alice${SEP}2026-01-01T00:00:00Z`;
        const result = parseLogOutput(out);
        expect(result[0].subject).toBe('Fix "quotes" & <tags>');
    });
});

describe('parseCommitDetail', () => {
    it('parses commit detail with body', () => {
        const out = [
            'abc123full',
            'abc1234',
            'Alice',
            'alice@example.com',
            '2026-06-17T10:00:00-04:00',
            'Fix the bug\n\nThis fixes issue #123.\nSigned-off-by: Alice',
        ].join(SEP);

        const result = parseCommitDetail(out);
        expect(result.hash).toBe('abc123full');
        expect(result.shortHash).toBe('abc1234');
        expect(result.authorName).toBe('Alice');
        expect(result.authorEmail).toBe('alice@example.com');
        expect(result.authorDate).toBe('2026-06-17T10:00:00-04:00');
        expect(result.body).toContain('Fix the bug');
        expect(result.body).toContain('issue #123');
    });

    it('handles body containing record separator character', () => {
        const out = [
            'abc123',
            'abc1',
            'Alice',
            'a@b.com',
            '2026-01-01T00:00:00Z',
            `Body with ${SEP} separator inside`,
        ].join(SEP);

        const result = parseCommitDetail(out);
        expect(result.body).toContain(SEP);
        expect(result.hash).toBe('abc123');
    });

    it('handles empty body', () => {
        const out = `abc${SEP}ab${SEP}Alice${SEP}a@b.com${SEP}2026-01-01T00:00:00Z${SEP}Subject only`;
        const result = parseCommitDetail(out);
        expect(result.body).toBe('Subject only');
    });
});

describe('parseStatusAndNumstat', () => {
    it('parses modified files', () => {
        const statusOut = 'M\tsrc/foo.ts\nM\tsrc/bar.ts';
        const numstatOut = '10\t5\tsrc/foo.ts\n3\t1\tsrc/bar.ts';

        const result = parseStatusAndNumstat(statusOut, numstatOut);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            path: 'src/foo.ts',
            oldPath: undefined,
            status: 'M',
            additions: 10,
            deletions: 5,
        });
        expect(result[1].additions).toBe(3);
    });

    it('parses added and deleted files', () => {
        const statusOut = 'A\tnew.ts\nD\told.ts';
        const numstatOut = '20\t0\tnew.ts\n0\t15\told.ts';

        const result = parseStatusAndNumstat(statusOut, numstatOut);
        expect(result[0]).toMatchObject({ path: 'new.ts', status: 'A', additions: 20, deletions: 0 });
        expect(result[1]).toMatchObject({ path: 'old.ts', status: 'D', additions: 0, deletions: 15 });
    });

    it('parses renamed files', () => {
        const statusOut = 'R100\told/path.ts\tnew/path.ts';
        const numstatOut = '2\t1\told/path.ts\tnew/path.ts';

        const result = parseStatusAndNumstat(statusOut, numstatOut);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            path: 'new/path.ts',
            oldPath: 'old/path.ts',
            status: 'R',
            additions: 2,
            deletions: 1,
        });
    });

    it('parses copied files', () => {
        const statusOut = 'C100\tsrc.ts\tdest.ts';
        const numstatOut = '0\t0\tsrc.ts\tdest.ts';

        const result = parseStatusAndNumstat(statusOut, numstatOut);
        expect(result[0].status).toBe('C');
        expect(result[0].oldPath).toBe('src.ts');
    });

    it('handles binary files (- for additions/deletions)', () => {
        const statusOut = 'M\timage.png';
        const numstatOut = '-\t-\timage.png';

        const result = parseStatusAndNumstat(statusOut, numstatOut);
        expect(result[0]).toMatchObject({ path: 'image.png', additions: 0, deletions: 0 });
    });

    it('returns empty array for empty output', () => {
        const result = parseStatusAndNumstat('', '');
        expect(result).toEqual([]);
    });
});

describe('parseBlameOutput', () => {
    it('parses porcelain blame output', () => {
        const output = [
            'abc123def456abc123def456abc123def456abcd 1 1 3',
            'author Alice',
            'author-mail <alice@example.com>',
            'author-time 1718640000',
            'author-tz -0400',
            'committer Alice',
            'committer-mail <alice@example.com>',
            'committer-time 1718640000',
            'committer-tz -0400',
            'summary Fix the bug',
            'filename src/foo.ts',
            '\tconst x = 1;',
            'abc123def456abc123def456abc123def456abcd 2 2',
            'author Alice',
            'author-mail <alice@example.com>',
            'author-time 1718640000',
            'author-tz -0400',
            'committer Alice',
            'committer-mail <alice@example.com>',
            'committer-time 1718640000',
            'committer-tz -0400',
            'summary Fix the bug',
            'filename src/foo.ts',
            '\tconst y = 2;',
            '',
        ].join('\n');

        const result = parseBlameOutput(output);
        expect(result).toHaveLength(2);
        expect(result[0].sha).toBe('abc123def456abc123def456abc123def456abcd');
        expect(result[0].shortSha).toBe('abc123de');
        expect(result[0].author).toBe('Alice');
        expect(result[0].authorEmail).toBe('alice@example.com');
        expect(result[0].timestamp).toBe(1718640000);
        expect(result[0].summary).toBe('Fix the bug');
        expect(result[0].lineNo).toBe(1);
        expect(result[0].content).toBe('const x = 1;');
        expect(result[1].lineNo).toBe(2);
        expect(result[1].content).toBe('const y = 2;');
    });

    it('handles multiple commits in blame', () => {
        const sha1 = 'a'.repeat(40);
        const sha2 = 'b'.repeat(40);
        const output = [
            `${sha1} 1 1 1`,
            'author Alice',
            'author-mail <alice@a.com>',
            'author-time 1000000',
            'summary First commit',
            'filename f.ts',
            '\tline one',
            `${sha2} 2 2 1`,
            'author Bob',
            'author-mail <bob@b.com>',
            'author-time 2000000',
            'summary Second commit',
            'filename f.ts',
            '\tline two',
            '',
        ].join('\n');

        const result = parseBlameOutput(output);
        expect(result).toHaveLength(2);
        expect(result[0].author).toBe('Alice');
        expect(result[0].summary).toBe('First commit');
        expect(result[1].author).toBe('Bob');
        expect(result[1].summary).toBe('Second commit');
    });

    it('returns empty array for empty output', () => {
        expect(parseBlameOutput('')).toEqual([]);
    });
});
