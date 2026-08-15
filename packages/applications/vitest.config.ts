import { defineConfig } from 'vitest/config';

/**
 * Vitest 4.1.10 pulls Vite 8 / Oxc. Oxc honors `emitDecoratorMetadata` from
 * `tsconfig.json` (esbuild did not), which turns type-only imports such as
 * `EntityId` into runtime mock misses. Test files are also excluded from
 * `tsconfig.json`, so Oxc drops legacy decorators and chokes on `@(expr)`.
 * Force the previous esbuild-equivalent: legacy decorators, no metadata.
 */
const nestjsOxcDecorators = {
  decorator: {
    legacy: true,
    emitDecoratorMetadata: false,
  },
} as const;

export default defineConfig({
  oxc: nestjsOxcDecorators,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // `.env.test` sets `SECRETS_PROVIDER=vault` (the correct
    // default for integration/e2e suites, which run against a real
    // Vault-backed SecretsService). Plain unit tests in this package build
    // services directly, without a SecretsService, so the shared PHI-field
    // encryption guard (`isPhiEncryptionRequired`) throws
    // "field encryption is required (SECRETS_PROVIDER=vault) but no
    // SecretsService is available" for every model with an encrypted field —
    // even in suites with zero encryption logic, since `.env.test` is loaded
    // process-wide. Override to `env` mode for this package's unit run only;
    // vault-mode (fail-closed) behavior keeps real coverage in
    // `src/common/__tests__/phi-field-encryption.test.ts`, which drives
    // `encryptPhiFields`/`isPhiEncryptionRequired` with an explicit
    // `{ SECRETS_PROVIDER: 'vault' }` env object rather than relying on
    // ambient `process.env`. Mirrors the existing pattern in
    // `apps/api/vitest.config.ts` (`test.env.DATABASE_URL` override).
    env: {
      SECRETS_PROVIDER: 'env',
    },
  },
});
