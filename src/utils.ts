export function safeJsonStringify(obj: unknown): string {
    return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
