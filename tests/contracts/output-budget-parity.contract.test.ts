/**
 * TASK-1000 — the output-budget rule is stated twice and must mean the same thing in both places.
 *
 * `packages/database` seeds a value onto each agent row; `packages/applications` clamps every
 * live generation into `[templateFloor, platformCeiling]` at runtime. Neither package may import
 * the other (`packages/database` cannot depend on `@arcaai/applications`, and an application
 * service must not import `@arcaai/database` runtime code), so the two declare the same two
 * numbers independently — exactly the shape that drifts silently.
 *
 * A drift here is not cosmetic. If the seed's floor were LOWER than the runtime's, every admin
 * console would display a budget smaller than the one actually used; if it were HIGHER, the
 * runtime would quietly cap a value an operator had deliberately raised. This test is the only
 * thing that makes the two halves one rule.
 */
import { describe, expect, it } from 'vitest';

import {
  SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS,
  SUMMARIZATION_TOKENS_PER_SECTION,
  summarizationMaxTokens,
} from '../../packages/database/src/prisma/db_main/seed/25-agents';
import {
  OUTPUT_TOKENS_ABSOLUTE_FLOOR,
  OUTPUT_TOKENS_PER_SECTION,
  outputBudgetFloor,
} from '../../packages/applications/src/services/consultation/live-documentation/output-budget';

describe('TASK-1000 — seed and runtime agree on the live-summary output budget', () => {
  it('declares the same absolute floor', () => {
    expect(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS).toBe(OUTPUT_TOKENS_ABSOLUTE_FLOOR);
  });

  it('declares the same per-section allowance', () => {
    expect(SUMMARIZATION_TOKENS_PER_SECTION).toBe(OUTPUT_TOKENS_PER_SECTION);
  });

  it('computes an identical budget for every section count the platform ships', () => {
    // 5 (diet revisit) through 23 (surgical oncology intake), plus the degenerate cases.
    for (const sections of [0, 1, 5, 6, 7, 8, 10, 11, 12, 13, 14, 16, 23, 40]) {
      expect(summarizationMaxTokens(sections), `sections=${sections}`).toBe(outputBudgetFloor(sections));
    }
  });
});
