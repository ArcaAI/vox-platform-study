// Coverage check.
//
// No production source file may
// read these secret env vars directly. Allowed exceptions:
//   - **/__tests__/** and **/*.test.ts (test fixtures)
//   - **/*.md (documentation — historical context)
//   - packages/database/src/prisma/db_main/seed/** (not yet migrated)
//   - packages/applications/.../config.service.ts (env fallback for MQTT_PASS
//     / REDIS_PASS that loadVaultSecrets() overlays — intentional per plan)
//   - packages/tools/src/gen-dev-token/** (standalone CLI dev tool; no
//     NestJS DI container available)
//   - packages/applications/scripts/** (dev-tooling scripts —
//     build-excluded via tsconfig rootDir=src + ESLint-ignored; they
//     intentionally bypass the NestJS DI graph / SecretsService and read
//     MINIO_* from .env.dev, same rationale as gen-dev-token)
//
// Run as: pnpm --filter @arcaai/applications test -- secrets-coverage
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MIGRATED_SECRETS = [
  'JWT_SECRET_KEY',
  'SESSION_SECRET_KEY',
  'API_KEY_PEPPER',
  'OIDC_CLIENT_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'TEXT_SERVICE_TOKEN',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  // MQTT_PASS / REDIS_PASS deliberately omitted — config.service.ts
  // keeps their env-fallback reads (overlaid by loadVaultSecrets()).
];

describe('Phase 3 coverage — no stray process.env secret reads', () => {
  it('returns zero matches across packages/ + apps/ (excluding allowed paths)', () => {
    const repoRoot = resolve(__dirname, '../../../../../..');
    const pattern = `process\\.env\\.(${MIGRATED_SECRETS.join('|')})`;
    const rx = new RegExp(pattern);
    const matches: string[] = [];

    const isAllowedPath = (relativePath: string): boolean => {
      const normalized = relativePath.split(sep).join('/');
      return (
        normalized.includes('/__tests__/') ||
        normalized.endsWith('.test.ts') ||
        normalized.endsWith('.test.tsx') ||
        normalized.endsWith('.md') ||
        normalized.startsWith('packages/database/src/prisma/db_main/seed/') ||
        normalized === 'packages/applications/src/services/baseServices/_meta/config/config.service.ts' ||
        normalized.startsWith('packages/tools/src/gen-dev-token/') ||
        normalized.startsWith('packages/applications/scripts/') ||
        normalized.includes('/.env')
      );
    };

    const shouldScanFile = (filePath: string): boolean => {
      const normalized = filePath.split(sep).join('/');
      return /\.(ts|tsx|md|yml|yaml)$/.test(normalized);
    };

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        const relativePath = fullPath.slice(repoRoot.length + 1);
        if (isAllowedPath(relativePath)) continue;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          walk(fullPath);
          continue;
        }
        if (!shouldScanFile(fullPath)) continue;
        const content = readFileSync(fullPath, 'utf8');
        content.split(/\r?\n/).forEach((line, index) => {
          if (rx.test(line)) {
            matches.push(`${relativePath}:${index + 1}:${line}`);
          }
        });
      }
    };

    walk(resolve(repoRoot, 'packages'));
    walk(resolve(repoRoot, 'apps'));

    if (matches.length > 0) {
      // Make the failure message actionable.
      throw new Error(
        `Phase 3 coverage check FAILED. The following sites still read secrets ` +
          `from process.env directly:\n\n${matches.join('\n')}\n` +
          `Each must be migrated to SecretsService (sync sites: getSecretSync; ` +
          `async sites: getSecret / getSecretOptional). See ` +
          `02-vault-migration.md Phase 3 for the patterns.`,
      );
    }
    expect(matches).toHaveLength(0);
  });
});
