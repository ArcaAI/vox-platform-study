// TASK-888 — every gateway→TEXT caller in this package presents the ONE shared
// internal token.
//
// Owner rule: a single devops-set `INTERNAL_ACCESS_TOKEN` authenticates every
// internal hop. `TEXT_SERVICE_TOKEN` was the per-service migration fallback;
// TASK-883 retired the three proxy readers in `apps/api`, and these ten call
// sites were the reason the descriptor could not follow it — each still named
// `TEXT_SERVICE_TOKEN` as the legacy argument to `resolveInternalAccessToken`.
// `apps/text` stopped ACCEPTING the legacy name well before that (its
// `InternalAccessConfig.token` reads `INTERNAL_ACCESS_TOKEN` and nothing else),
// so the fallback could not have authenticated anything anyway.
//
// This file replaces `consultation/summary/__tests__/text-service-token-migration.test.ts`,
// which pinned the OPPOSITE invariant (that each site DID name the legacy key).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

/** Every `packages/applications` production file that authenticates a hop to `apps/text`. */
const SOURCES = [
  'services/consultation/summary/summary.service.ts',
  'services/consultation/summary/chain-summary.service.ts',
  'services/consultation/jobs/processors/pre-summary.processor.ts',
  'services/consultation/jobs/processors/comprehensive-summary.processor.ts',
  'services/consultation/live-documentation/live-documentation.service.ts',
  'services/dna-writing-style/dna-writing-style.processor.ts',
  'services/agent/agent-invocation.service.ts',
  'services/prompt-management/prompt-management.service.ts',
];

describe('gateway→TEXT callers present INTERNAL_ACCESS_TOKEN', () => {
  for (const rel of SOURCES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('reads no service token from process.env', () => {
        expect(src).not.toMatch(/process\.env\.(TEXT_)?SERVICE_TOKEN/);
        expect(src).not.toMatch(/process\.env\.INTERNAL_ACCESS_TOKEN/);
      });

      it('resolves the token through SecretsService', () => {
        expect(src).toMatch(/resolveInternalAccessToken\(\s*this\.secretsService,\s*'INTERNAL_ACCESS_TOKEN'\s*\)/);
      });

      it('never names the retired per-service TEXT_SERVICE_TOKEN as a lookup key', () => {
        // The name may still appear in a comment recording what was retired and
        // why; what must not survive is a lookup of it.
        expect(src).not.toMatch(/(getSecret\w*|resolveInternalAccessToken)\([^)]*['"]TEXT_SERVICE_TOKEN['"]/);
      });
    });
  }
});
