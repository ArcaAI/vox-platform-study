import { describe, expect, it } from 'vitest';
import { BUDGET_SAFETY_FACTOR, budgetFor } from '../residency-budget';

const MiB = 1024 * 1024;

describe('budgetFor (TASK-1051 F8)', () => {
  it('uses a measured footprint as is', () => {
    expect(budgetFor(2_000_000_000, 1700)).toEqual({ bytes: 2_000_000_000, source: 'measured' });
  });

  it('budgets a never-measured model at the catalogue estimate × the safety factor', () => {
    expect(budgetFor(null, 1700)).toEqual({ bytes: Math.ceil(1700 * MiB * BUDGET_SAFETY_FACTOR), source: 'catalogue' });
  });

  it('is unknown — never 0 — with neither', () => {
    expect(budgetFor(undefined, null)).toEqual({ bytes: null, source: 'unknown' });
    expect(budgetFor(0, 0)).toEqual({ bytes: null, source: 'unknown' });
  });
});
