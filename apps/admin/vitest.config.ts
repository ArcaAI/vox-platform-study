import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Stub the workspace packages in unit tests — `@arcaai/ui` source pulls heavy
 * deps (three.js, pdf.js, lexical) and `@arcaai/vox` pulls onnxruntime; neither
 * is needed for the pure-logic mappers/adapters we unit test here.
 */
const STUB_PACKAGES = [/^@arcaai\/ui\//, /^@arcaai\/vox/];

function stubExternalPackages(): Plugin {
    return {
        name: 'stub-external-packages',
        enforce: 'pre',
        resolveId(source) {
            if (STUB_PACKAGES.some((re) => re.test(source))) {
                return `\0stub:${source}`;
            }
        },
        load(id) {
            if (id.startsWith('\0stub:')) {
                return 'export default {}';
            }
        },
    };
}

export default defineConfig({
    plugins: [stubExternalPackages(), react()],
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/__tests__/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
