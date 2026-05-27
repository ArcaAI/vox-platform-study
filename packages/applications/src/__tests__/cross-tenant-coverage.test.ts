/**
 * Cross-tenant test coverage aggregator — TASK-305 Phase E.2 / E.3.
 *
 * The plan's original E.2 layout convention (a separate
 * `**\/__tests__/cross-tenant.*.test.ts` per service) was NOT followed.
 * Wave 1-3 instead added cross-tenant negative tests INLINE to each
 * service's existing test file, plus dedicated test blocks for queue
 * processors and event handlers. Both approaches achieve the same
 * coverage goal; this aggregator pins the inline approach so a future
 * regression (e.g. someone deletes the `describe('TASK-305 D.x ...')`
 * block) trips CI.
 *
 * For each entry in the allow-list:
 *  - the test file MUST exist
 *  - it MUST contain at least one `describe(...)` line whose label
 *    matches the entry's `marker` regex
 *  - the `it()` blocks nested under those matching describes MUST be
 *    at least `minTests` in count
 *
 * The minimums come from the W3 progress report (`docs/implementation/
 * TASK-305-Multi-Tenancy-Hardening/README.md` §6) cross-referenced
 * with the Phase E spec. They are conservative floors, not ceilings —
 * the actual counts at the time of writing exceed them in every case
 * (see `docs/multi-tenancy-audit/06-implementation-summary.md`).
 *
 * Heuristic for counting: walk the source line-by-line, track brace
 * depth, push the current depth whenever we hit a `describe(...)` line
 * whose label matches `marker`, and count `it(...)` lines as long as
 * we are still inside one or more matching describes. The walker is
 * intentionally text-based (no AST) so it stays test-runtime cheap.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Root of `packages/applications/src/`. Resolved from this test file's
 * directory so the aggregator is portable across worktree layouts.
 */
const APPLICATIONS_SRC = resolve(__dirname, '..');

interface CoverageEntry {
  readonly name: string;
  /** Relative to `packages/applications/src/`. */
  readonly file: string;
  /** Floor — actual count should exceed this. */
  readonly minTests: number;
  /** Identifies the describe block(s) the inline tests live in. */
  readonly marker: RegExp;
}

/**
 * Phase E.2 — service-layer cross-tenant tests.
 *
 * Service / minTests cross-references with W1.4, W2.D6, W3.1, W3.2,
 * W3.3, W1.3, W1.4 (`§6` table in the plan README). The marker regex
 * matches the `describe('...TASK-305 D.x — ...')` /
 * `describe('Multi-tenant scoping (TASK-305 D.x)')` /
 * `describe('Cross-Tenant Isolation')` patterns used across the codebase.
 */
const SERVICE_COVERAGE: readonly CoverageEntry[] = [
  {
    name: 'auditLog',
    file: 'services/auditLog/__tests__/auditLog.service.test.ts',
    minTests: 10,
    marker: /TASK-305 D\.8|Multi-tenant scoping/,
  },
  {
    name: 'audit/authorization-audit',
    file: 'services/audit/__tests__/authorization-audit.service.test.ts',
    // TASK-306 P1.2 added 3 new it() blocks under the `TASK-306 P1.2`
    // marker (CLS-derived tenantId on logToDatabase). Bumped 5 → 8.
    minTests: 8,
    marker: /TASK-305 D\.8|Multi-tenant scoping|TASK-306/,
  },
  {
    name: 'apiKey',
    file: 'services/apiKey/__tests__/apikey.service.test.ts',
    // TASK-306 P1.5 added 3 new it() blocks under the `TASK-306 P1.5`
    // marker (fetchAllByTenantId CLS gate). Bumped 10 → 13.
    minTests: 13,
    marker: /TASK-305 D\.5|Multi-tenant scoping|TASK-306/,
  },
  {
    name: 'consultation/consultation',
    file: 'services/consultation/consultation/__tests__/consultation.service.test.ts',
    // TASK-306 P2.1 added 9 new it() blocks under the `TASK-306 P2.1 —
    // Consultation read-paths defense-in-depth` marker (3 getById +
    // 2 getByIdWithRelations + 4 getConsultationChain). Bumped 5 → 14.
    minTests: 14,
    marker: /TASK-305 D\.2|cross-aggregate tenant|TASK-306/i,
  },
  {
    name: 'consultation/context',
    file: 'services/consultation/context/__tests__/context.service.test.ts',
    minTests: 5,
    marker: /TASK-305 D\.3|cross-aggregate tenant/i,
  },
  {
    name: 'consultation/summary',
    file: 'services/consultation/summary/__tests__/summary.service.test.ts',
    minTests: 3,
    marker: /TASK-305 D\.4|cross-aggregate tenant/i,
  },
  {
    name: 'consultation/summary/chain-summary',
    file: 'services/consultation/summary/__tests__/chain-summary.service.test.ts',
    minTests: 1,
    marker: /TASK-305 D\.4|cross-aggregate tenant/i,
  },
  {
    name: 'department',
    file: 'services/department/__tests__/department.service.test.ts',
    minTests: 4,
    marker: /TASK-305 D\.6|cross-tenant parent/i,
  },
  {
    name: 'dna-writing-style',
    file: 'services/dna-writing-style/__tests__/dna-writing-style.service.test.ts',
    minTests: 5,
    marker: /TASK-305 D\.5|Cross-Tenant Isolation|Multi-tenant scoping/,
  },
  {
    name: 'notification',
    file: 'services/notification/__tests__/notification.service.test.ts',
    // TASK-306 P1.5 added 3 new it() blocks under the `TASK-306 P1.5`
    // marker (fetchAllByTenantId CLS gate). Bumped 10 → 13.
    minTests: 13,
    marker: /TASK-305 D\.5|Multi-tenant scoping|TASK-306/,
  },
  {
    name: 'user/userRoleAssignment',
    file: 'services/user/userRoleAssignment/__tests__/userRoleAssignment.service.test.ts',
    minTests: 3,
    marker: /TASK-305 D\.7|tenantId pinning/i,
  },
  /*
   * TASK-306 W5.1 + W5.3 — services that previously had no cross-tenant
   * aggregator entry. Each tracks its own `describe('TASK-306 P1.x ...')`
   * / `describe('TASK-306 P2.x ...')` block via a `TASK-306` marker so a
   * future delete of the block trips CI (mirrors the W5.5.6
   * anti-regression intent). The marker is intentionally broad
   * (`/TASK-306/`) so subsequent waves can extend the same coverage
   * without churning this allow-list.
   */
  {
    name: 'tenant',
    file: 'services/tenant/__tests__/tenant.service.test.ts',
    // TASK-306 P1.3 added 6 it() blocks (3 per method: fetchById +
    // fetchByCodeName, same-tenant / cross-tenant non-admin /
    // cross-tenant SUPER_ADMIN).
    // TASK-306 P2.2 / W5.3.1 added 6 more (same matrix for
    // fetchTenantConfigs by tenantId + by codeName). 6 → 12.
    minTests: 12,
    marker: /TASK-306/,
  },
  {
    name: 'webhook',
    file: 'services/webhook/__tests__/webhook.service.test.ts',
    // TASK-306 P1.4 added 3 it() blocks under the
    // `resolveEffectiveTenantId` describe (non-admin cross-tenant pin,
    // non-admin no-DTO pin, SUPER_ADMIN cross-tenant honor).
    // TASK-306 P2.3 / W5.3.2-5.3.6 added 14 more:
    //   - fetchAll (5.3.2): 2 (CLS-injected filter, SUPER_ADMIN bypass)
    //   - fetchById (5.3.3): 3 (same / cross 404 / SUPER_ADMIN)
    //   - update (5.3.4): 3 (same / cross 404 / SUPER_ADMIN)
    //   - deleteById (5.3.5): 3 (same / cross 404 / SUPER_ADMIN)
    //   - fetchAllByTenantId (5.3.6): 3 (same / cross 404 / SUPER_ADMIN)
    // 3 → 17.
    minTests: 17,
    marker: /TASK-306/,
  },
  /*
   * TASK-306 W5.3 — ResourceSubscriptionService had no cross-tenant
   * aggregator entry pre-W5.3 because the service was tenant-blind on
   * every surface. W5.3.7-5.3.11 added a full DEF-C3 sweep across 5
   * methods. All tests live under
   * `describe('TASK-306 P2.4 — ResourceSubscription tenant-guard
   * sweep')`. Floor counts:
   *   - fetchAll (5.3.7): 2
   *   - fetchAllByResource (5.3.8): 2
   *   - fetchById (5.3.9): 3
   *   - update (5.3.10): 3
   *   - deleteById (5.3.11): 3
   * Total ≥ 13.
   */
  {
    name: 'resourceSubscription',
    file: 'services/resourceSubscription/__tests__/resourceSubscription.service.test.ts',
    minTests: 13,
    marker: /TASK-306/i,
  },
];

/**
 * Phase E.3 — BullMQ processor + NestJS event-handler CLS-rebind tests.
 *
 * All 6 queue/event handlers wrap their work body in `cls.run(...)`
 * with the tenant id pulled from the job/event payload, fail-closed if
 * the payload omits `tenantId`, and (for read-then-mutate processors)
 * `assertEqualTenants` the loaded entity against the payload. Tests
 * live in the dedicated `describe('CLS rebind ...')` /
 * `describe('AuditLogProcessor — CLS rebind ...')` blocks.
 */
const PROCESSOR_COVERAGE: readonly CoverageEntry[] = [
  {
    name: 'summary.processor',
    file: 'services/consultation/jobs/__tests__/summary.processor.test.ts',
    minTests: 3,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
  {
    name: 'pre-summary.processor',
    file: 'services/consultation/jobs/__tests__/pre-summary.processor.test.ts',
    minTests: 3,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
  {
    name: 'comprehensive-summary.processor',
    file: 'services/consultation/jobs/__tests__/comprehensive-summary.processor.test.ts',
    minTests: 3,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
  {
    name: 'ner.processor',
    file: 'services/consultation/jobs/__tests__/ner.processor.test.ts',
    minTests: 3,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
  {
    name: 'auditLog.processor',
    file: 'services/auditLog/__tests__/auditLog.processor.test.ts',
    minTests: 3,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
  {
    name: 'consultation-event.handler',
    file: 'services/consultation/events/__tests__/consultation-event.handler.test.ts',
    minTests: 6,
    marker: /CLS rebind|TASK-305 D\.9/,
  },
];

/**
 * Count `it(...)` blocks whose nearest enclosing `describe(...)` line
 * matches `marker`. Brace-depth tracking handles nested describes.
 *
 * Exported through the module's surface so the test file is the only
 * runtime consumer; not exposed for re-use outside this aggregator.
 */
function countItInMatchingDescribes(source: string, marker: RegExp): number {
  let count = 0;
  let depth = 0;
  const matchingDepths: number[] = [];
  const lines = source.split('\n');

  for (const line of lines) {
    if (/describe\s*\(/.test(line) && marker.test(line)) {
      matchingDepths.push(depth);
    }
    if (matchingDepths.length > 0 && /\bit\s*\(/.test(line)) {
      count++;
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    while (matchingDepths.length > 0 && depth <= matchingDepths[matchingDepths.length - 1]) {
      matchingDepths.pop();
    }
  }
  return count;
}

function readSource(relativePath: string): string {
  const full = resolve(APPLICATIONS_SRC, relativePath);
  return readFileSync(full, 'utf8');
}

describe('Cross-tenant test coverage aggregator (TASK-305 E.2/E.3)', () => {
  describe('E.2 — service-layer inline cross-tenant tests', () => {
    it.each(SERVICE_COVERAGE)(
      '$name has ≥$minTests cross-tenant tests in $file',
      ({ file, minTests, marker }) => {
        const source = readSource(file);
        expect(marker.test(source)).toBe(true);
        const count = countItInMatchingDescribes(source, marker);
        expect(count).toBeGreaterThanOrEqual(minTests);
      },
    );
  });

  describe('E.3 — processor + event-handler CLS-rebind tests', () => {
    it.each(PROCESSOR_COVERAGE)(
      '$name has ≥$minTests CLS-rebind/fail-closed tests in $file',
      ({ file, minTests, marker }) => {
        const source = readSource(file);
        expect(marker.test(source)).toBe(true);
        const count = countItInMatchingDescribes(source, marker);
        expect(count).toBeGreaterThanOrEqual(minTests);
      },
    );
  });

  it('introspection counter handles brace-tracked nested describes', () => {
    const sample = `
      describe('TASK-305 D.x — sample outer', () => {
        describe('inner unrelated', () => {
          it('should be counted because outer matches', () => {});
        });
      });
      describe('unrelated outer', () => {
        it('should NOT be counted', () => {});
      });
    `;
    expect(countItInMatchingDescribes(sample, /TASK-305 D\.x/)).toBe(1);
  });

  it('returns 0 when the marker never matches', () => {
    const sample = `
      describe('unrelated', () => {
        it('foo', () => {});
        it('bar', () => {});
      });
    `;
    expect(countItInMatchingDescribes(sample, /TASK-305 D\.x/)).toBe(0);
  });
});
