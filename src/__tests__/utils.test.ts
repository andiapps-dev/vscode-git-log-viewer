import { describe, it, expect } from 'vitest';
import { safeJsonStringify } from '../utils';

describe('safeJsonStringify', () => {
    it('serializes plain objects normally', () => {
        const result = safeJsonStringify({ name: 'test', count: 42 });
        expect(JSON.parse(result)).toEqual({ name: 'test', count: 42 });
    });

    it('escapes < and > to prevent script tag breakout', () => {
        const result = safeJsonStringify({ path: '</script><img src=x>' });
        expect(result).not.toContain('</script>');
        expect(result).not.toContain('<img');
        expect(result).toContain('\\u003c');
        expect(result).toContain('\\u003e');
    });

    it('escaped output still parses to original value', () => {
        const original = { path: '</script><img src=x onerror=alert(1)>' };
        const result = safeJsonStringify(original);
        expect(JSON.parse(result)).toEqual(original);
    });

    it('handles nested objects with angle brackets', () => {
        const obj = { a: { b: '<script>alert(1)</script>' } };
        const result = safeJsonStringify(obj);
        expect(result).not.toContain('<script>');
        expect(JSON.parse(result)).toEqual(obj);
    });

    it('handles arrays', () => {
        const result = safeJsonStringify(['<a>', '<b>']);
        expect(result).not.toContain('<a>');
        expect(JSON.parse(result)).toEqual(['<a>', '<b>']);
    });

    it('handles strings with no angle brackets', () => {
        const result = safeJsonStringify({ safe: 'hello world' });
        expect(result).toBe('{"safe":"hello world"}');
    });

    it('handles null and undefined values', () => {
        expect(safeJsonStringify(null)).toBe('null');
        expect(safeJsonStringify({ a: undefined })).toBe('{}');
    });
});
