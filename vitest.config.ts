import { defineConfig } from 'vitest/config';
import path from 'path';

// Excluded from EVERY aggregate suite (unit / integration / e2e) by owner
// directive — see `.claude/rules/01-development-workflow.md` §Test Scope
// Exclusions. `apps/quick-compat-app` is not even a workspace member
// (pnpm-workspace.yaml negates it), so its suites must never be discovered here.
const SKIPPED_WORKSPACE_DIRS = ['packages/ui/**', 'apps/compat-playground/**', 'apps/quick-compat-app/**'];

const SHARED_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  // Claude Code spins up throwaway repo copies under `.claude/worktrees/` for
  // isolated background agents. They are untracked scratch and (usually) lack
  // resolved deps, so scanning them double-counts every suite and fails on
  // ERR_MODULE_NOT_FOUND. Never a real source root — exclude from discovery.
  // (Anchored, not `**/.claude/**`: a leading `**` glob does not descend into
  // hidden `.`-prefixed dirs in the exclude matcher.)
  '.claude/**',
  '**/e2e/**',
  '**/*.e2e-spec.ts',
  '**/integration/**',
  '**/*.integration.ts',
  // Infra-dependent suites with their own runners — not part of `test:unit`.
  // PgBouncer rig runs via `pnpm pgbv:test` (needs the pooler on :6532);
  // *.postgres.test.ts is a live-Postgres regression guard.
  '**/pgbouncer-validation/**',
  '**/*.postgres.test.ts',
  // Owner directive (2026-08-19, `01-development-workflow.md` §Test Scope
  // Exclusions): these three workspaces are OUT of every aggregate suite. Run
  // them only via their own `pnpm --filter <pkg> test` when the change is
  // inside them.
  ...SKIPPED_WORKSPACE_DIRS,
];

// Component/browser packages own their vitest config (jsdom/happy-dom env, the
// React transform, their own setup files and `@/` aliases) AND their suites
// assume `cwd = the package root` (e.g. packages/ui reads `src/styles/globals.css`
// off process.cwd()). Vitest projects run with cwd = the repo root, which breaks
// that assumption, so these packages are NOT hosted as root projects — the node
// `workspace` project excludes their dirs, and `pnpm test:unit` runs each via its
// own `pnpm --filter … test` (correct cwd + config). Notes:
//   - packages/ui runs `*.vitest.{ts,tsx}` (its `*.test.tsx` are Playwright CT,
//     run by `ui:test:ct` — not vitest).
//   - packages/agentic-sdk-v2 (vox) runs `*.test.{ts,tsx}` under jsdom (its real
//     environment); they used to run here in node as an accident of the glob.
//   - apps/compat-playground names its suites `*.test.tsx` (happy-dom).
//   - apps/admin-console uses a NESTED-projects config (server node + client
//     happy-dom) + `@vitejs/plugin-react` that isn't resolvable from the repo root.
// `packages/ui` and `apps/compat-playground` are additionally in
// SKIPPED_WORKSPACE_DIRS above (never run by an aggregate suite at all).
const BROWSER_PACKAGE_DIRS = ['packages/ui/**', 'packages/agentic-sdk-v2/**', 'apps/compat-playground/**', 'apps/admin-console/**'];

export default defineConfig({
  // Vitest 4.1.10 → Vite 8/Oxc: keep NestJS legacy decorators, skip metadata
  // (see packages/applications/vitest.config.ts).
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: false,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // `.test.js` catches the eslint-plugin RuleTester suites (node); the `.tsx`
    // component suites are covered by the referenced browser projects below.
    include: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.js'],
    exclude: SHARED_EXCLUDE,
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'workspace',
          // Node/`.ts` suites across the whole repo (incl. the top-level
          // tests/contracts + tests/cross-tenant, which no package owns), MINUS
          // the browser packages that run under their own config below.
          exclude: [...SHARED_EXCLUDE, ...BROWSER_PACKAGE_DIRS],
          // Unit suites run with MOCKED repositories/SecretsService and assert the PHI
          // encrypt-on-write SOFT no-op path (phi-field-encryption.ts: SECRETS_PROVIDER
          // != 'vault' → skip; == 'vault' → fail-closed throw). `.env.test` deliberately
          // carries SECRETS_PROVIDER=vault for the seed / test-API / e2e / integration
          // flows (real Vault Transit — see scripts/test-setup.sh). Pin the unit workers
          // to soft mode here so `pnpm test:unit` is correct regardless of `.env.test`
          // and never depends on a hand-maintained value. Scoped to this project only, so
          // integration (its own config) keeps vault. Project `env` overrides the
          // dotenv-cli-injected value.
          env: {
            SECRETS_PROVIDER: 'env',
          },
          // `packages/applications/.../image-thumbnail.service.test.ts` deliberately
          // exercises the REAL `sharp` codec (not mocked). sharp's native libvips
          // addon is not safe under Node's worker_threads (Vitest's default `threads`
          // pool) — it segfaults (SIGSEGV, exit 139) nondeterministically, worse here
          // since two libvips builds are resolvable in this workspace (sharp 0.35.3
          // direct dep of @arcaai/applications vs 0.34.5 transitive via
          // @huggingface/transformers / Next.js). `forks` isolates each test file in
          // its own OS process instead of a shared V8 isolate, which native addons
          // require. Same fix already applied in vitest.integration.config.ts.
          pool: 'forks',
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only collect coverage for files that are actually imported during tests
      // The 'all' option would include all files matching include patterns
      // but can cause issues in monorepos
      include: [
        'packages/applications/src/**/*.ts',
        'packages/domains/src/**/*.ts',
        'packages/logger/src/**/*.ts',
        'packages/exceptions/src/**/*.ts',
        'packages/pipeline/src/**/*.ts',
        'packages/agentic-sdk-v2/src/**/*.ts',
        'packages/med-ner/src/**/*.ts',
        'packages/stt/src/**/*.ts',
        'packages/vad/src/**/*.ts',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        '**/tests/**',
        '**/__tests__/**',
        '**/e2e/**',
        '**/integration/**',
        '**/generated/**',
        '**/*.module.ts',
        '**/main.ts',
        '**/*.config.ts',
        '**/setup/**',
        '**/fixtures/**',
        '**/mocks/**',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'threads',
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@tests': path.resolve(__dirname, './tests'),
      // Resolve the actively-developed @arcaai/applications package from source
      // rather than its built ./dist. The direct-vitest path (`test:unit`) does
      // not build first (unlike turbo's `test` task), so an incremental rebuild
      // writing dist/index.js concurrently produced "Failed to resolve entry for
      // package" races. Source resolution removes that dependency on build state
      // and matches the coverage config, which already targets packages/*/src.
      '@arcaai/applications': path.resolve(__dirname, './packages/applications/src/index.ts'),
    },
  },
});
