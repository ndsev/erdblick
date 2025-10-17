import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        clearMocks: true,
        pool: 'forks',
        isolate: false,
        include: ['app/**/*.spec.ts'],
        exclude: [
            'node_modules/**',
            'build/**',
            'ci/**',
            'app/app.component.spec.ts',
        ],
    },
});
