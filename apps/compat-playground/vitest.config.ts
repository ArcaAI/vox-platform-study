import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Component-test config for the compat playground. Browser-side suites are
 * named `*.test.tsx` (mirroring the admin-console convention) so the root
 * `vitest.config.ts` — which only includes `**\/*.test.ts` — never collects
 * them into its node project. They run via
 * `pnpm --filter @arcaai/compat-playground test`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: [fromHere('./src/test/setup.ts')],
    include: ['src/**/*.test.tsx'],
  },
});
