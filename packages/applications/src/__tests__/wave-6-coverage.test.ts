/**
 * Direct-Prisma-removal coverage aggregator.
 *
 * Three controllers (`auth.controller.ts`, `policies.controller.ts`,
 * `roles.controller.ts`) stopped touching `databaseService.client`
 * directly and now route through new application-service methods, as
 * a behaviour-preserving refactor. The end-to-end gateway behaviour is
 * pinned by the EXISTING E2E suite (`apps/api/tests/e2e/`), which a
 * cross-tenant aggregator in `apps/api/src/__tests__/
 * e2e-tenant-coverage.test.ts` will track once that file lands.
 *
 * The new unit tests this refactor added are not cross-tenant tests,
 * so they do not belong in `cross-tenant-coverage.test.ts`. They ARE
 * the pin against the new service-method behaviour, though — deleting
 * them leaves the extractions unprotected. This aggregator closes that
 * gap with the smallest viable surface:
 *
 *   1. Per-sub-task entry — file path + minimum `it(...)` count +
 *      describe-marker regex (mirrors the
 *      `cross-tenant-coverage.test.ts` shape).
 *   2. Existence pin — every entry must point to a file on disk.
 *   3. Describe-marker pin — the top-level describe block each entry
 *      targets must still exist (so a future engineer that renames
 *      the block trips CI).
 *   4. Count floor — actual `it()` count under the matching describe
 *      MUST be ≥ floor (so a future engineer that deletes a pin
 *      trips CI). Floors are conservative — the actual counts at
 *      authoring time exceed them by 1–2 each.
 *
 * Exports:
 *   - `WAVE_6_TEST_COVERAGE` — typed constant so the gateway-level
 *     cross-tenant aggregator (`apps/api/src/__tests__/
 *     e2e-tenant-coverage.test.ts`) can import it via a relative path
 *     and fold these floors into its own coverage report.
 *
 * Pattern reuse: this file deliberately mirrors the shape of
 * `cross-tenant-coverage.test.ts` (the brace-tracked `it()` counter,
 * the `readSource` helper, the `it.each(...)` parameterised test
 * shape) so a future engineer maintaining either aggregator
 * recognises the contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Root of `packages/applications/src/`. Same convention as
 * `cross-tenant-coverage.test.ts` so the aggregator is portable
 * across worktree layouts.
 */
const APPLICATIONS_SRC = resolve(__dirname, '..');

interface WaveSixEntry {
  /** Identifier tying the entry to its describe-marker regex. */
  readonly subtask: string;
  /** Human-readable name used in the parameterised test label. */
  readonly name: string;
  /** Relative to `packages/applications/src/`. */
  readonly file: string;
  /** Floor — actual `it()` count must be ≥ this. */
  readonly minTests: number;
  /** Identifies the top-level describe block the pins live in. */
  readonly marker: RegExp;
}

/**
 * The three service-layer test files this refactor added.
 *
 * Floors are set 1–2 below the actual count at authoring time so a
 * single accidental deletion (or a renamed `it(...)` that no longer
 * matches the describe scope) trips CI. The aggregator pin is
 * intentionally narrow: it does NOT try to enumerate every method
 * sub-describe (e.g. `findAll`, `findOne`, `create`, ...). The
 * top-level marker + floor combination is sufficient — and easier
 * to maintain than per-method floors.
 */
export const WAVE_6_TEST_COVERAGE: readonly WaveSixEntry[] = [
  {
    subtask: 'W6.1',
    name: 'UserRoleAssignmentService tenant-scoped reads',
    file: 'services/user/userRoleAssignment/__tests__/userRoleAssignment.service.task307.test.ts',
    // 7 it() blocks at authoring time across 3 methods
    // (findActiveAssignmentForUserInTenant / findActiveTenantIdsForUser /
    // findActiveRolesForUser). Floor 6 catches a single deletion.
    minTests: 6,
    marker: /UserRoleAssignmentService tenant-scoped reads/,
  },
  {
    subtask: 'W6.2',
    name: 'PolicyService',
    file: 'services/rbac/policy/__tests__/policy.service.task307.test.ts',
    // 12 it() blocks at authoring time across validateRules /
    // findAll / findOne / create / update / patch / softDelete.
    // Floor 10 catches up to 2 deletions.
    minTests: 10,
    marker: /describe\('PolicyService'/,
  },
  {
    subtask: 'W6.3',
    name: 'RbacRoleService',
    file: 'services/rbac/role/__tests__/role.service.task307.test.ts',
    // 14 it() blocks at authoring time across findAll / findOne /
    // create / update / patch / softDelete / assignPolicy /
    // removePolicy. Floor 12 catches up to 2 deletions.
    minTests: 12,
    marker: /describe\('RbacRoleService'/,
  },
];

/**
 * Count `it(...)` blocks whose nearest enclosing `describe(...)` line
 * matches `marker`. Brace-depth tracking handles nested describes.
 *
 * Lifted verbatim from `cross-tenant-coverage.test.ts` so the
 * counting contract is identical across both aggregators. (Both
 * files are test code under `packages/applications/src/__tests__/`
 * — extracting a shared helper module would be premature.)
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

describe('Wave 6 — Direct-Prisma-removal coverage aggregator', () => {
  it('every WAVE_6_TEST_COVERAGE entry points to a file that exists on disk', () => {
    const missing = WAVE_6_TEST_COVERAGE.filter((entry) => !existsSync(resolve(APPLICATIONS_SRC, entry.file))).map((entry) => entry.file);
    expect(missing).toEqual([]);
  });

  it.each(WAVE_6_TEST_COVERAGE)('$subtask — $name has ≥$minTests pins in $file under marker $marker', ({ file, minTests, marker }) => {
    const source = readSource(file);
    expect(marker.test(source)).toBe(true);
    const count = countItInMatchingDescribes(source, marker);
    expect(count).toBeGreaterThanOrEqual(minTests);
  });

  /*
   * Hand-off note (consumed by `apps/api/src/__tests__/
   * e2e-tenant-coverage.test.ts`, once that gateway-level aggregator
   * exists):
   *
   *   import { WAVE_6_TEST_COVERAGE } from '@arcaai/applications/.../wave-6-coverage.test';
   *   // (or duplicate the contract — service-layer floors don't
   *   //  need to flow into the gateway-level aggregator; it may
   *   //  choose to keep them as parallel pins instead of importing.)
   *
   * This aggregator is intentionally scoped to this unit-test
   * surface. The auth / policies / roles controllers it covers have
   * NO new E2E spec files — behaviour preservation is pinned by the
   * EXISTING `apps/api/tests/e2e/` suite, which the gateway-level
   * aggregator will track via the `cross-tenant-coverage.test.ts`
   * FS-introspection mechanism.
   *
   * The ESLint rule `arcaai-internal/no-controller-direct-prisma` is
   * self-tested by `packages/eslint-plugin-arcaai-internal/__tests__/
   * no-controller-direct-prisma.test.js` — it does NOT need an
   * aggregator entry because the RuleTester is the contract.
   */
});
