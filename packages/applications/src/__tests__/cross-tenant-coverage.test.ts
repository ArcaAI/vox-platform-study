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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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
    // TASK-306 W5.5.7 / 306-F10 fold-in. Pre-W5.5.7 the marker had
    // been narrowed from `/TASK-305 D\.3|cross-aggregate tenant/i`
    // → `/TASK-306/` (W5.4.2 / W5.3.12 single-token convention).
    // The narrowing left the 8 TASK-305 D.3 cross-aggregate tenant
    // tests pinned only by the W5.5.6 FS-introspection — fine for
    // existence, but the explicit floor only tracked the 9 TASK-306
    // P2.5 tests. 306-F10 broadens the marker back to a 3-token
    // pattern (matching the `consultation/consultation` entry above)
    // so the floor explicitly tracks BOTH cross-tenant test blocks
    // in the file. Floor bumped 9 → 17 (= 8 TASK-305 D.3 + 9 TASK-306
    // P2.5). Verified by counting it() blocks against the broad
    // marker before commit.
    minTests: 17,
    marker: /TASK-305 D\.3|cross-aggregate tenant|TASK-306/i,
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
    // TASK-466 (C1-05) — the harness callback receiver's recordEscalation
    // asserts the 404-over-403 posture (a cross-tenant consultation surfaces as
    // NotFoundException, via assertEqualTenants) alongside the missing-tenant
    // guard, so the file now carries cross-tenant coverage. Floor is the two
    // tenancy-guard tests in that describe (the marker captures the whole block).
    name: 'consultation/harness/harness-internal',
    file: 'services/consultation/harness/__tests__/harness-internal.service.test.ts',
    minTests: 2,
    marker: /recordEscalation \(C1-05\)/,
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
  /*
   * Surfaced by the TASK-306 W5.5.6 FS-introspection (NEW-7 / F-4):
   * `prompt-management.service.test.ts` exercises cross-tenant
   * isolation under two describes — `Cross-Tenant Isolation` (the
   * pre-TASK-305 informal convention) and `Authorization & tenant
   * scope (DEF-C2)` (the TASK-294 DEF-C2 convention). Both were never
   * registered in this allow-list before; the introspection harden
   * exposed the gap. Marker captures both describes; floor is the
   * conservative current count of the DEF-C2 block (10) so any
   * future deletion of either describe is caught.
   */
  {
    name: 'prompt-management',
    file: 'services/prompt-management/__tests__/prompt-management.service.test.ts',
    minTests: 10,
    marker: /Cross-Tenant Isolation|DEF-C2|TASK-306/,
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
    // cross-tenant GLOBAL_ADMIN).
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
    // non-admin no-DTO pin, GLOBAL_ADMIN cross-tenant honor).
    // TASK-306 P2.3 / W5.3.2-5.3.6 added 14 more:
    //   - fetchAll (5.3.2): 2 (CLS-injected filter, GLOBAL_ADMIN bypass)
    //   - fetchById (5.3.3): 3 (same / cross 404 / GLOBAL_ADMIN)
    //   - update (5.3.4): 3 (same / cross 404 / GLOBAL_ADMIN)
    //   - deleteById (5.3.5): 3 (same / cross 404 / GLOBAL_ADMIN)
    //   - fetchAllByTenantId (5.3.6): 3 (same / cross 404 / GLOBAL_ADMIN)
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
    // TASK-306 W5.5.7 / 306-F9 fold-in (cosmetic): dropped the `/i`
    // flag from the marker. `TASK-306` is always written upper-case
    // in describe titles per the W5.3.12 convention; the `/i` flag
    // was a copy-paste from the older `/cross-aggregate tenant/i`
    // shape and serves no purpose here.
    minTests: 13,
    marker: /TASK-306/,
  },
  /*
   * TASK-306 W5.5.7 — W5.5 base-layer additions.
   *
   * These entries point OUTSIDE `services/` (one in `common/`, one in
   * `services/baseServices/`) so the W5.5.6 FS-introspection walker
   * does not auto-discover them — but the cross-tenant assertions
   * they hold are central to the multi-tenancy contract, so the
   * aggregator pins them explicitly:
   *
   *   - `base.service` (W5.5.1 / audit M-5): `broadcastSysEvent` CLS
   *     wins on tenantId. Floor 3 per spec — actual count is 4 and
   *     can grow; floor catches a 2-test regression.
   *   - `core.unitOfWork` (W5.5.2 / audit M-6): the new
   *     `runInTransaction` canonical `$transaction(callback)`
   *     contract. Floor 3 per spec — actual count is 4.
   */
  {
    name: 'common/base.service',
    file: 'common/__tests__/base.service.test.ts',
    minTests: 3,
    marker: /TASK-306/,
  },
  {
    name: 'baseServices/core.unitOfWork',
    file: 'services/baseServices/unitsOfWork/__tests__/core.unitOfWork.test.ts',
    minTests: 3,
    marker: /TASK-306/,
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

/*
 * TASK-306 W5.5.6 / NEW-7 / F-4 — FS-introspection harden.
 *
 * Before this commit `SERVICE_COVERAGE` was a hand-maintained allow-list.
 * A new cross-tenant test added in a service that had no entry (or a
 * service that gained its FIRST cross-tenant negative test in a later
 * wave) would never trip CI — the gap was structural. NEW-7 / F-4
 * called that out; W5.5 promotes the fix in-scope.
 *
 * The harden walks `packages/applications/src/services/` end-to-end,
 * picks every `<name>.service.test.ts` file whose CONTENTS reference at
 * least one of the narrow set of cross-tenant signals below
 * (TENANT_SCOPED_DETECTION), and asserts that each such file is
 * registered in `SERVICE_COVERAGE`. The reverse direction is asserted
 * too — every `SERVICE_COVERAGE` entry must point to a file that
 * actually exists on disk.
 *
 * The detection set is intentionally narrower than the user-spec list
 * (which included a bare `tenantId` matcher). A bare `tenantId` match
 * has too many false positives — services that incidentally mention
 * tenantId in setup code (logger setup, JWT issuance, AppSettings
 * boot) would flood the gap list. The narrower set targets the
 * actual guard helpers exposed by `packages/applications/src/common/
 * tenant-guards.ts` (TASK-305 W1.2), the cross-tenant test describe
 * conventions (`TASK-305 D.x`, `TASK-306`, `Multi-tenant scoping`,
 * `Cross-Tenant Isolation`, `cross-aggregate tenant`), and the
 * legacy `DEF-C2` block convention from TASK-294. A file matches if
 * ANY of these tokens appears anywhere in its source.
 */
const TENANT_SCOPED_DETECTION =
  /assertEqualTenants|assertParentInScope|assertUserBelongsToTenant|assertCrossAggregateRefsInTenant|resolveEffectiveTenantId|TASK-305 D\.|TASK-306|Multi-tenant scoping|Cross-Tenant Isolation|cross-aggregate tenant|DEF-C2/;

/**
 * Recursively walk `dir`, collecting absolute paths of files whose
 * BASENAME matches `pattern`. Sync FS — these tests run in-process and
 * the directory tree is small (~70 files), so adding `fast-glob` as a
 * dep would be overkill.
 */
function findFiles(dir: string, pattern: RegExp, results: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, pattern, results);
    } else if (pattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Returns the set of `services/**` test files (relative to
 * `APPLICATIONS_SRC`) whose source contains AT LEAST ONE of the
 * tenant-scoped detection tokens. Sorted so failure diffs are stable.
 */
function detectTenantScopedTestFiles(servicesDir: string): string[] {
  const allTestFiles = findFiles(servicesDir, /\.service\.test\.ts$/);
  const tenantScoped: string[] = [];
  for (const file of allTestFiles) {
    const source = readFileSync(file, 'utf8');
    if (TENANT_SCOPED_DETECTION.test(source)) {
      tenantScoped.push(relative(APPLICATIONS_SRC, file));
    }
  }
  return tenantScoped.sort();
}

/**
 * Returns the set of `SERVICE_COVERAGE` files that are NOT covered
 * given `tenantScopedFiles`. Pure function — used both by the live
 * assertion and the meta-test below.
 */
function findUncoveredFiles(
  tenantScopedFiles: readonly string[],
  serviceCoverage: readonly { file: string }[],
): string[] {
  const covered = new Set(serviceCoverage.map((entry) => entry.file));
  return tenantScopedFiles.filter((file) => !covered.has(file));
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

  /*
   * TASK-306 W5.5.6 / NEW-7 / F-4 — FS-introspection harden. See the
   * block comment on `TENANT_SCOPED_DETECTION` above for the design
   * rationale. The live assertion walks the real filesystem; the
   * two meta-tests below pin the detection algorithm itself against
   * fixtures so a refactor of `findUncoveredFiles` cannot silently
   * regress.
   */
  describe('TASK-306 W5.5.6 — aggregator FS-introspection (NEW-7 / F-4)', () => {
    it('every tenant-scoped service test file is registered in SERVICE_COVERAGE', () => {
      const servicesDir = resolve(APPLICATIONS_SRC, 'services');
      const detected = detectTenantScopedTestFiles(servicesDir);
      const uncovered = findUncoveredFiles(detected, SERVICE_COVERAGE);

      // If this assertion fires, a service test file added a cross-tenant
      // test (or one of the tenant-guard helper calls) but its file is
      // not yet in SERVICE_COVERAGE. Add an entry with the appropriate
      // marker + minTests floor — see the existing entries for the
      // pattern. This is exactly the gap NEW-7 / F-4 was tracking.
      expect(uncovered).toEqual([]);
    });

    it('every SERVICE_COVERAGE entry points to a file that exists on disk', () => {
      const missing = SERVICE_COVERAGE.filter(
        (entry) => !existsSync(resolve(APPLICATIONS_SRC, entry.file)),
      ).map((entry) => entry.file);
      expect(missing).toEqual([]);
    });

    it('detects gaps when SERVICE_COVERAGE is missing an entry (meta-test on findUncoveredFiles)', () => {
      // Pure-function fixture: NO real filesystem touch, NO real
      // SERVICE_COVERAGE inspection. This proves the gap-detection
      // logic itself is correct — i.e. if a real tenant-scoped file
      // exists and SERVICE_COVERAGE omits it, `findUncoveredFiles`
      // returns its path verbatim.
      const fakeTenantScopedFiles = [
        'services/foo/__tests__/foo.service.test.ts',
        'services/bar/__tests__/bar.service.test.ts',
        'services/baz/__tests__/baz.service.test.ts',
      ];
      const fakeServiceCoverage = [
        { file: 'services/foo/__tests__/foo.service.test.ts' },
        // bar.service.test.ts intentionally missing — the meta-test
        // proves the algorithm surfaces it.
        { file: 'services/baz/__tests__/baz.service.test.ts' },
      ];

      const missing = findUncoveredFiles(fakeTenantScopedFiles, fakeServiceCoverage);

      expect(missing).toEqual(['services/bar/__tests__/bar.service.test.ts']);
    });

    it('returns no gaps when every tenant-scoped file is covered (meta-test happy path)', () => {
      const fakeTenantScopedFiles = [
        'services/foo/__tests__/foo.service.test.ts',
        'services/bar/__tests__/bar.service.test.ts',
      ];
      const fakeServiceCoverage = [
        { file: 'services/foo/__tests__/foo.service.test.ts' },
        { file: 'services/bar/__tests__/bar.service.test.ts' },
        // An extra unrelated entry should NOT count as a gap.
        { file: 'services/baz/__tests__/baz.service.test.ts' },
      ];

      expect(findUncoveredFiles(fakeTenantScopedFiles, fakeServiceCoverage)).toEqual([]);
    });

    it('TENANT_SCOPED_DETECTION matches each guard token (meta-test on the detection regex)', () => {
      // The detection regex is the contract between the FS walker and
      // the SERVICE_COVERAGE allow-list. Pinning each token
      // individually catches a refactor that accidentally drops one.
      const tokens = [
        'assertEqualTenants',
        'assertParentInScope',
        'assertUserBelongsToTenant',
        'assertCrossAggregateRefsInTenant',
        'resolveEffectiveTenantId',
        'TASK-305 D.7',
        'TASK-306 P2.1',
        'Multi-tenant scoping',
        'Cross-Tenant Isolation',
        'cross-aggregate tenant',
        'DEF-C2',
      ];
      for (const token of tokens) {
        expect(
          TENANT_SCOPED_DETECTION.test(`some surrounding source code ${token} more code`),
        ).toBe(true);
      }
      // And a negative — pure casual `tenantId` mention should NOT
      // flag the file (it'd produce too many false positives, e.g.
      // logger / appSettings setup blocks).
      expect(
        TENANT_SCOPED_DETECTION.test(`const tenantId = "tenant-1";`),
      ).toBe(false);
    });
  });
});
