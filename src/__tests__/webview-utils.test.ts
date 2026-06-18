import { describe, it, expect, vi } from 'vitest';
import { sortArray, statusClass, statusLabel, escapeHtml, formatDate, formatTimeAgo } from '../../webview/utils';

describe('sortArray', () => {
    const items = [
        { name: 'Charlie', age: 30 },
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 35 },
    ];

    it('sorts by string field ascending', () => {
        const result = sortArray(items, 'name', true);
        expect(result.map(i => i.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('sorts by string field descending', () => {
        const result = sortArray(items, 'name', false);
        expect(result.map(i => i.name)).toEqual(['Charlie', 'Bob', 'Alice']);
    });

    it('sorts by numeric field ascending', () => {
        const result = sortArray(items, 'age', true);
        expect(result.map(i => i.age)).toEqual([25, 30, 35]);
    });

    it('sorts by numeric field descending', () => {
        const result = sortArray(items, 'age', false);
        expect(result.map(i => i.age)).toEqual([35, 30, 25]);
    });

    it('returns empty array for empty input', () => {
        expect(sortArray([], 'name' as never, true)).toEqual([]);
    });

    it('does not mutate original array', () => {
        const original = [...items];
        sortArray(items, 'name', true);
        expect(items).toEqual(original);
    });

    it('handles single-element array', () => {
        const result = sortArray([{ name: 'A', age: 1 }], 'name', true);
        expect(result).toEqual([{ name: 'A', age: 1 }]);
    });
});

describe('statusClass', () => {
    it('maps A to added', () => expect(statusClass('A')).toBe('added'));
    it('maps M to modified', () => expect(statusClass('M')).toBe('modified'));
    it('maps D to deleted', () => expect(statusClass('D')).toBe('deleted'));
    it('maps R to renamed', () => expect(statusClass('R')).toBe('renamed'));
    it('maps unknown to modified', () => expect(statusClass('X')).toBe('modified'));
    it('maps empty to modified', () => expect(statusClass('')).toBe('modified'));
});

describe('statusLabel', () => {
    it('maps A to Added', () => expect(statusLabel('A')).toBe('Added'));
    it('maps M to Modified', () => expect(statusLabel('M')).toBe('Modified'));
    it('maps D to Deleted', () => expect(statusLabel('D')).toBe('Deleted'));
    it('maps R to Renamed', () => expect(statusLabel('R')).toBe('Renamed'));
    it('maps C to Copied', () => expect(statusLabel('C')).toBe('Copied'));
    it('returns raw string for unknown', () => expect(statusLabel('T')).toBe('T'));
});

describe('escapeHtml', () => {
    it('escapes angle brackets', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes ampersands', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes double quotes', () => {
        expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
    });

    it('leaves safe strings unchanged', () => {
        expect(escapeHtml('hello world 123')).toBe('hello world 123');
    });

    it('handles empty string', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('handles multiple special characters', () => {
        expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    });
});

describe('formatDate', () => {
    it('formats valid ISO date', () => {
        const result = formatDate('2024-06-15T10:30:00Z');
        expect(result).toBeTruthy();
        expect(result).not.toBe('2024-06-15T10:30:00Z');
    });

    it('returns original string for invalid date', () => {
        expect(formatDate('not-a-date')).toBe('not-a-date');
    });

    it('returns original string for empty string', () => {
        expect(formatDate('')).toBe('');
    });

    it('handles date with timezone offset', () => {
        const result = formatDate('2024-01-15T14:30:00-05:00');
        expect(result).toBeTruthy();
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('formatTimeAgo', () => {
    const now = Math.floor(Date.now() / 1000);

    it('returns just now for recent timestamps', () => {
        expect(formatTimeAgo(now - 30)).toBe('just now');
    });

    it('returns minutes ago', () => {
        expect(formatTimeAgo(now - 300)).toBe('5m ago');
    });

    it('returns hours ago', () => {
        expect(formatTimeAgo(now - 7200)).toBe('2h ago');
    });

    it('returns days ago', () => {
        expect(formatTimeAgo(now - 86400 * 5)).toBe('5d ago');
    });

    it('returns months ago', () => {
        expect(formatTimeAgo(now - 86400 * 60)).toBe('2mo ago');
    });

    it('returns years ago', () => {
        expect(formatTimeAgo(now - 86400 * 400)).toBe('1y ago');
    });

    it('boundary: exactly 60 seconds returns 1m', () => {
        expect(formatTimeAgo(now - 60)).toBe('1m ago');
    });

    it('boundary: 59 seconds returns just now', () => {
        expect(formatTimeAgo(now - 59)).toBe('just now');
    });

    it('boundary: exactly 24 hours returns 1d', () => {
        expect(formatTimeAgo(now - 86400)).toBe('1d ago');
    });
});
