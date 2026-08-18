// Pin TEXT_SERVICE_TOKEN migration in place.
// Static grep over the production SMR call sites.
//
// Each site must NOT read process.env.TEXT_SERVICE_TOKEN and MUST go
// through SecretsService (async getSecretOptional or sync getSecretSync).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../../..');

const SOURCES = [
  // service-layer call sites (async — getSecretOptional)
  'src/services/consultation/summary/summary.service.ts',
  'src/services/consultation/summary/chain-summary.service.ts',
  // TASK-732 — 'jobs/processors/summary.processor.ts' deleted (legacy
  // signable generator); 'pre-summary'/'comprehensive-summary' survive.
  'src/services/consultation/jobs/processors/pre-summary.processor.ts',
  'src/services/consultation/jobs/processors/comprehensive-summary.processor.ts',
  'src/services/dna-writing-style/dna-writing-style.processor.ts',
];

describe('TEXT_SERVICE_TOKEN migration (Phase 3 Task 3.4)', () => {
  for (const rel of SOURCES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('does not read process.env.TEXT_SERVICE_TOKEN', () => {
        expect(src).not.toMatch(/process\.env\.TEXT_SERVICE_TOKEN/);
      });

      it('reads TEXT_SERVICE_TOKEN via SecretsService', () => {
        // Two accepted shapes:
        //  - the original direct read (optional chaining allowed, for sites that
        //    fall back when SecretsService is not provided in tests);
        //  - `resolveInternalAccessToken(secrets, 'TEXT_SERVICE_TOKEN')` — the
        //    D-D shared-token resolver, which asks SecretsService for the ONE
        //    `INTERNAL_ACCESS_TOKEN` first and keeps `TEXT_SERVICE_TOKEN` as the
        //    migration fallback. Both go through SecretsService, which is what
        //    this gate is actually pinning; neither reads `process.env`.
        expect(src).toMatch(
          /(secretsService\??\.(getSecretOptional|getSecret|getSecretSync)\(['"]TEXT_SERVICE_TOKEN['"]|resolveInternalAccessToken\([^)]*['"]TEXT_SERVICE_TOKEN['"])/,
        );
      });
    });
  }
});
