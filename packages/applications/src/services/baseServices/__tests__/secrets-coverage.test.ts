// TASK-302 Phase 3 Task 3.12 — coverage check.
//
// After Phase 3 (sites 3.1–3.11 migrated), no production source file may
// read these secret env vars directly. Allowed exceptions:
//   - **/__tests__/** and **/*.test.ts (test fixtures)
//   - **/*.md (documentation — historical context)
//   - packages/database/src/prisma/db_main/seed/** (Phase 4D will handle)
//   - packages/applications/.../config.service.ts (env fallback for MQTT_PASS
//     / REDIS_PASS that loadVaultSecrets() overlays — intentional per plan)
//   - packages/tools/src/gen-dev-token/** (standalone CLI dev tool; no
//     NestJS DI container available)
//
// Run as: pnpm --filter @arcaai/applications test -- secrets-coverage
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const MIGRATED_SECRETS = [
  'JWT_SECRET_KEY',
  'SESSION_SECRET_KEY',
  'API_KEY_PEPPER',
  'OIDC_CLIENT_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'SMR_SERVICE_TOKEN',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  // MQTT_PASS / REDIS_PASS deliberately omitted — config.service.ts
  // keeps their env-fallback reads (overlaid by loadVaultSecrets()).
];

describe('Phase 3 coverage — no stray process.env secret reads', () => {
  it('returns zero matches across packages/ + apps/ (excluding allowed paths)', () => {
    const repoRoot = resolve(__dirname, '../../../../../..');
    const pattern = `process\\.env\\.(${MIGRATED_SECRETS.join('|')})`;
    let stdout: string;
    try {
      // git grep prints matches and exits 0 (has matches) or 1 (none).
      stdout = execSync(
        `git grep -nE "${pattern}" -- 'packages/' 'apps/' ` +
          `':(exclude)**/__tests__/**' ` +
          `':(exclude)**/*.test.ts' ` +
          `':(exclude)**/*.md' ` +
          `':(exclude)**/.env*' ` +
          `':(exclude)packages/database/src/prisma/db_main/seed/**' ` +
          `':(exclude)packages/applications/src/services/baseServices/_meta/config/config.service.ts' ` +
          `':(exclude)packages/tools/src/gen-dev-token/**'`,
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch (e: unknown) {
      // exit code 1 = no matches found (success). Anything else is a hard error.
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) {
        stdout = '';
      } else {
        throw e;
      }
    }
    if (stdout.trim().length > 0) {
      // Make the failure message actionable.
      throw new Error(
        `Phase 3 coverage check FAILED. The following sites still read secrets ` +
          `from process.env directly:\n\n${stdout}\n` +
          `Each must be migrated to SecretsService (sync sites: getSecretSync; ` +
          `async sites: getSecret / getSecretOptional). See ` +
          `02-vault-migration.md Phase 3 for the patterns.`,
      );
    }
    expect(stdout.trim()).toBe('');
  });
});
