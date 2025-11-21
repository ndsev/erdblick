import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        clearMocks: true,
        pool: 'forks',
        isolate: false,
        setupFiles: ['test/vitest.setup.ts'],
        include: ['app/**/*.spec.ts'],
        exclude: [
            'node_modules/**',
            'build/**',
            'ci/**',
            'app/app.component.spec.ts'
        ],
        coverage: {
            enabled: true,
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcov'],
            reportsDirectory: 'coverage',
        },
    },
});
