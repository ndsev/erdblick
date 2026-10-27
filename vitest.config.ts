import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        clearMocks: true,
        pool: 'forks',
        isolate: false,
        setupFiles: ['tests/support/vitest.setup.ts'],
        include: ['tests/app/**/*.spec.ts'],
        exclude: [
            'node_modules/**',
            'build/**',
            'ci/**'
        ],
        coverage: {
            enabled: true,
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
            reportsDirectory: 'coverage',
            exclude: [],
        },
    },
});
