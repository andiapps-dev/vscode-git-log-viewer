import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    test: {
        include: ['src/__tests__/**/*.test.ts', 'webview/__tests__/**/*.test.ts'],
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            include: [
                'src/gitService.ts',
                'src/messageHandler.ts',
                'src/diffDocProvider.ts',
                'src/utils.ts',
                'webview/utils.ts',
                'webview/main.ts',
            ],
            exclude: ['src/__tests__/**', 'webview/__tests__/**'],
            thresholds: {
                lines: 97,
                functions: 100,
                branches: 85,
                statements: 97,
            },
        },
    },
    resolve: {
        alias: {
            '../../webview': path.resolve(__dirname, 'webview'),
        },
    },
});
