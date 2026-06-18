import { describe, it, expect } from 'vitest';

// DiffDocProvider uses vscode APIs, so we test the URI encoding/decoding logic directly
// by reimplementing the pure parts here

interface DiffDocParams {
    repoRoot: string;
    sha: string;
    filePath: string;
}

function encodeParams(repoRoot: string, sha: string, filePath: string): string {
    const params: DiffDocParams = { repoRoot, sha, filePath };
    return Buffer.from(JSON.stringify(params)).toString('base64');
}

function decodeParams(query: string): DiffDocParams {
    return JSON.parse(Buffer.from(query, 'base64').toString('utf-8'));
}

describe('DiffDocProvider URI encoding', () => {
    it('roundtrips basic params', () => {
        const encoded = encodeParams('/repo', 'abc123', 'src/foo.ts');
        const decoded = decodeParams(encoded);
        expect(decoded).toEqual({
            repoRoot: '/repo',
            sha: 'abc123',
            filePath: 'src/foo.ts',
        });
    });

    it('handles paths with special characters', () => {
        const encoded = encodeParams('/my repo', 'abc', 'path/with spaces/file (1).ts');
        const decoded = decodeParams(encoded);
        expect(decoded.repoRoot).toBe('/my repo');
        expect(decoded.filePath).toBe('path/with spaces/file (1).ts');
    });

    it('handles unicode in paths', () => {
        const encoded = encodeParams('/repo', 'abc', 'src/日本語.ts');
        const decoded = decodeParams(encoded);
        expect(decoded.filePath).toBe('src/日本語.ts');
    });

    it('handles sha with caret suffix', () => {
        const encoded = encodeParams('/repo', 'abc123^', 'file.ts');
        const decoded = decodeParams(encoded);
        expect(decoded.sha).toBe('abc123^');
    });

    it('returns empty params correctly', () => {
        const encoded = encodeParams('', '', '');
        const decoded = decodeParams(encoded);
        expect(decoded).toEqual({ repoRoot: '', sha: '', filePath: '' });
    });

    it('decoding empty query string throws', () => {
        expect(() => decodeParams('')).toThrow();
    });
});
