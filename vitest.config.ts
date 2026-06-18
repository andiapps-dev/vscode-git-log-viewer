import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    test: {
        include: ['src/__tests__/**/*.test.ts'],
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            include: [
                'src/gitService.ts',
                'src/messageHandler.ts',
                'src/utils.ts',
                'webview/utils.ts',
            ],
            exclude: ['src/__tests__/**'],
            thresholds: {
                lines: 90,
                functions: 90,
                branches: 85,
                statements: 90,
            },
        },
    },
    resolve: {
        alias: {
            '../../webview': path.resolve(__dirname, 'webview'),
        },
    },
});
