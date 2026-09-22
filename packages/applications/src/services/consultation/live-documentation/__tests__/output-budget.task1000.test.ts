/**
 * TASK-1000 — the output-token budget rule.
 *
 * The numbers here are the ones measured on `hope-v2-dev` on 2026-09-22, not illustrations:
 * `arcaai-bren-soap-new-visit` has 14 sections and its agent declared 2048, and that pairing is
 * the consultation whose note gained 5,324 characters of truncated JSON in its first section.
 */
import { describe, expect, it } from 'vitest';

import { OUTPUT_TOKENS_ABSOLUTE_FLOOR, outputBudgetFloor, repairOutputBudget, resolveOutputBudget } from '../output-budget';

const CEILING = 16384;

describe('outputBudgetFloor', () => {
  it('holds the owner-directed absolute floor for every template at or below 16 sections', () => {
    expect(outputBudgetFloor(5)).toBe(8192); // arcaai-diet-soap-revisit, the smallest
    expect(outputBudgetFloor(14)).toBe(8192); // arcaai-bren-soap-new-visit, the one that failed
    expect(outputBudgetFloor(16)).toBe(8192); // arcaai-derm-soap-new-visit
  });

  it('scales past the floor for the templates that are genuinely larger', () => {
    expect(outputBudgetFloor(23)).toBe(11776); // arcaai-sonc-soap-new-visit, the worst case
  });

  it('degrades to the absolute floor for an unresolvable section count', () => {
    // An unreadable template is a reason to be generous, never a reason to truncate.
    expect(outputBudgetFloor(0)).toBe(OUTPUT_TOKENS_ABSOLUTE_FLOOR);
    expect(outputBudgetFloor(-3)).toBe(OUTPUT_TOKENS_ABSOLUTE_FLOOR);
    expect(outputBudgetFloor(Number.NaN)).toBe(OUTPUT_TOKENS_ABSOLUTE_FLOOR);
  });
});

describe('resolveOutputBudget', () => {
  it('raises the seeded 2048 to the floor — the exact defect this ticket fixes', () => {
    expect(resolveOutputBudget(2048, 14, CEILING)).toBe(8192);
    expect(resolveOutputBudget(2048, 23, CEILING)).toBe(11776);
  });

  it('honours a declared value that already sits inside the band', () => {
    expect(resolveOutputBudget(10000, 14, CEILING)).toBe(10000);
  });

  it('caps a declared value at the platform ceiling — the `??` that made it a default is gone', () => {
    expect(resolveOutputBudget(99999, 14, CEILING)).toBe(CEILING);
  });

  it('takes the floor when the agent declares nothing', () => {
    expect(resolveOutputBudget(undefined, 23, CEILING)).toBe(11776);
  });

  it('lets the floor win over a ceiling misconfigured below it', () => {
    // 23 sections need 11,776; a ceiling of 8192 would be an instruction to truncate.
    expect(resolveOutputBudget(2048, 23, 8192)).toBe(11776);
  });
});

describe('repairOutputBudget', () => {
  it('doubles the budget that just truncated', () => {
    expect(repairOutputBudget(8192, CEILING)).toBe(16384);
  });

  it('never exceeds the ceiling', () => {
    expect(repairOutputBudget(11776, CEILING)).toBe(CEILING);
  });
});
