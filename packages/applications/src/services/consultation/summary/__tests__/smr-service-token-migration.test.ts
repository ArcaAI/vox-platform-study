// Pin SMR_SERVICE_TOKEN migration in place.
// Static grep over the production SMR call sites.
//
// Each site must NOT read process.env.SMR_SERVICE_TOKEN and MUST go
// through SecretsService (async getSecretOptional or sync getSecretSync).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../../..');

const SOURCES = [
  // service-layer call sites (async — getSecretOptional)
  'src/services/consultation/summary/summary.service.ts',
  'src/services/consultation/summary/chain-summary.service.ts',
  'src/services/consultation/jobs/processors/summary.processor.ts',
  'src/services/consultation/jobs/processors/pre-summary.processor.ts',
  'src/services/consultation/jobs/processors/comprehensive-summary.processor.ts',
  'src/services/dna-writing-style/dna-writing-style.processor.ts',
];

describe('SMR_SERVICE_TOKEN migration (Phase 3 Task 3.4)', () => {
  for (const rel of SOURCES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('does not read process.env.SMR_SERVICE_TOKEN', () => {
        expect(src).not.toMatch(/process\.env\.SMR_SERVICE_TOKEN/);
      });

      it('reads SMR_SERVICE_TOKEN via SecretsService', () => {
        // Allow optional chaining (?.) for sites that fall back when the
        // SecretsService is not provided in tests.
        expect(src).toMatch(
          /secretsService\??\.(getSecretOptional|getSecret|getSecretSync)\(['"]SMR_SERVICE_TOKEN['"]/,
        );
      });
    });
  }
});
