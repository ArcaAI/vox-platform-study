import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const APP_SRC = fromHere('./src');
const UI_SRC = fromHere('../../packages/ui/src');

/**
 * Importer-aware `@/` resolution: files inside packages/ui/src use the UI
 * package's own `@/*` alias (its tsconfig paths), while app files use this
 * app's `@/*` -> ./src mapping. A plain resolve.alias cannot distinguish the
 * two roots, so this resolves `@/*` based on which root the importing file
 * lives under.
 */
function importerAwareAtAlias(): Plugin {
  const extensions = ['.tsx', '.ts'];
  return {
    name: 'arcaai-importer-aware-at-alias',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.startsWith('@/')) return undefined;
      const base = importer && importer.startsWith(UI_SRC) ? UI_SRC : APP_SRC;
      const stem = join(base, source.slice(2));
      if (existsSync(stem) && statSync(stem).isFile()) return stem;
      for (const ext of extensions) {
        const candidate = `${stem}${ext}`;
        if (existsSync(candidate)) return candidate;
      }
      for (const ext of extensions) {
        const candidate = join(stem, `index${ext}`);
        if (existsSync(candidate)) return candidate;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [importerAwareAtAlias(), react()],
  resolve: {
    alias: {
      // `server-only` throws outside a React Server environment; tests
      // exercise the server modules directly, so stub it out.
      'server-only': fromHere('./src/test/stubs/server-only.ts'),
    },
  },
  test: {
    globals: true,
    setupFiles: [fromHere('./src/test/setup.ts')],
    // The 5s default is comfortable locally (this suite's slowest file spends
    // ~300ms in tests) but not on a shared CI runner, where every test job of
    // a manually-triggered pipeline competes for the same box and `findBy*`
    // waits have timed out mid-render. Raise the ceiling in CI only — a real
    // hang still fails, just 20s later.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'happy-dom',
          include: ['src/**/*.test.tsx'],
        },
      },
    ],
  },
});
