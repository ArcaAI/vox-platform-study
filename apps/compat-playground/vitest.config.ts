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
    // Vitest's 5000ms default is tuned for local dev hardware. These are
    // Radix-heavy component suites driven by real `userEvent` interaction
    // (typing, clicking, tab switches) on top of `@arcaai/ui`'s barrel — on
    // the CI runner (`node:22-alpine`, shared/CPU-constrained) the same
    // suites that finish in ~250ms locally were clocked at 5000-5800ms,
    // tripping the default ceiling mid-interaction. Matches the timeout
    // already used for every other Vitest project in the monorepo (e.g.
    // `packages/agentic-sdk-v2`, `packages/room`, `packages/domains`).
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
