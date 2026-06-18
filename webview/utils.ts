export function sortArray<T>(arr: T[], key: keyof T, asc: boolean): T[] {
    return [...arr].sort((a, b) => {
        const va = a[key];
        const vb = b[key];
        if (typeof va === 'number' && typeof vb === 'number') {
            return asc ? va - vb : vb - va;
        }
        const sa = String(va);
        const sb = String(vb);
        return asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
}

export function statusClass(s: string): string {
    switch (s) {
        case 'A': return 'added';
        case 'M': return 'modified';
        case 'D': return 'deleted';
        case 'R': return 'renamed';
        default: return 'modified';
    }
}

export function statusLabel(s: string): string {
    switch (s) {
        case 'A': return 'Added';
        case 'M': return 'Modified';
        case 'D': return 'Deleted';
        case 'R': return 'Renamed';
        case 'C': return 'Copied';
        default: return s;
    }
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        if (isNaN(d.getTime())) return isoDate;
        return d.toLocaleString();
    } catch {
        return isoDate;
    }
}

export function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
}
