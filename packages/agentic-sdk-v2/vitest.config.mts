import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/__tests__/vitest.setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
        exclude: ['node_modules', 'dist'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
        },
        // Mock external dependencies that may not be installed
        deps: {
            inline: [/@arcaai\//, /zustand/],
        },
        alias: {
            'highlight.run': new URL('./src/__tests__/mocks/highlight.mock.ts', import.meta.url).pathname,
            '@opentelemetry/api': new URL('./src/__tests__/mocks/otel.mock.ts', import.meta.url).pathname,
            'eventemitter3': new URL('./src/__tests__/mocks/eventemitter3.mock.ts', import.meta.url).pathname,
            '@arcaai/med-ner': new URL('./src/__tests__/mocks/med-ner.mock.ts', import.meta.url).pathname,
            '@arcaai/room': new URL('../room/src/index.ts', import.meta.url).pathname,
        },
    },
});
