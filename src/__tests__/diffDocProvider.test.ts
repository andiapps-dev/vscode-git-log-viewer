import { describe, it, expect, vi } from 'vitest';

// DiffDocProvider imports the real `vscode` module, which isn't resolvable
// outside a real extension host. Stub just the one API it actually touches
// (Uri.parse -> .query) so the real module can be imported and exercised.
// vi.mock calls are hoisted above the imports below by vitest's transform.
vi.mock('vscode', () => ({
    Uri: {
        parse: (value: string) => {
            const queryIndex = value.indexOf('?');
            return {
                scheme: value.split(':')[0],
                query: queryIndex >= 0 ? value.slice(queryIndex + 1) : '',
                toString: () => value,
            };
        },
    },
}));

import { DiffDocProvider } from '../diffDocProvider';
import type { GitService } from '../gitService';

function fakeUri(query: string) {
    return { query } as unknown as import('vscode').Uri;
}

describe('DiffDocProvider.encodeUri / decodeUri roundtrip', () => {
    it('roundtrips basic params', () => {
        const uri = DiffDocProvider.encodeUri('/repo', 'abc123', 'src/foo.ts');
        expect(DiffDocProvider.decodeUri(uri)).toEqual({
            repoRoot: '/repo',
            sha: 'abc123',
            filePath: 'src/foo.ts',
        });
    });

    it('handles paths with special characters', () => {
        const uri = DiffDocProvider.encodeUri('/my repo', 'abc', 'path/with spaces/file (1).ts');
        const decoded = DiffDocProvider.decodeUri(uri);
        expect(decoded.repoRoot).toBe('/my repo');
        expect(decoded.filePath).toBe('path/with spaces/file (1).ts');
    });

    it('handles unicode in paths', () => {
        const uri = DiffDocProvider.encodeUri('/repo', 'abc', 'src/日本語.ts');
        expect(DiffDocProvider.decodeUri(uri).filePath).toBe('src/日本語.ts');
    });

    it('handles sha with caret suffix', () => {
        const uri = DiffDocProvider.encodeUri('/repo', 'abc123^', 'file.ts');
        expect(DiffDocProvider.decodeUri(uri).sha).toBe('abc123^');
    });

    it('returns empty params correctly', () => {
        const uri = DiffDocProvider.encodeUri('', '', '');
        expect(DiffDocProvider.decodeUri(uri)).toEqual({ repoRoot: '', sha: '', filePath: '' });
    });

    it('decoding an empty query string throws', () => {
        expect(() => DiffDocProvider.decodeUri(fakeUri(''))).toThrow();
    });

    it('the encoded uri carries the scheme and filePath in its path portion', () => {
        const uri = DiffDocProvider.encodeUri('/repo', 'abc123', 'src/foo.ts');
        expect(uri.toString()).toContain(`${DiffDocProvider.scheme}:src/foo.ts?`);
    });
});

describe('DiffDocProvider.provideTextDocumentContent', () => {
    it('returns an empty string when the uri has no query', async () => {
        const gitService = { getFileAtRevision: vi.fn() } as unknown as GitService;
        const provider = new DiffDocProvider(gitService);
        const content = await provider.provideTextDocumentContent(fakeUri(''));
        expect(content).toBe('');
        expect(gitService.getFileAtRevision).not.toHaveBeenCalled();
    });

    it('decodes the uri and delegates to gitService.getFileAtRevision', async () => {
        const gitService = {
            getFileAtRevision: vi.fn().mockResolvedValue('file contents at revision'),
        } as unknown as GitService;
        const provider = new DiffDocProvider(gitService);

        const uri = DiffDocProvider.encodeUri('/repo', 'abc123', 'src/foo.ts');
        const content = await provider.provideTextDocumentContent(uri);

        expect(content).toBe('file contents at revision');
        expect(gitService.getFileAtRevision).toHaveBeenCalledWith('/repo', 'abc123', 'src/foo.ts');
    });
});
