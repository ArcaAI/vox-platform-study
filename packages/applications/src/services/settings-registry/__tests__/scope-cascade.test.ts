import { describe, expect, it } from 'vitest';
import { walkCascade, type CascadeTier } from '../scope-cascade';

// TASK-504 Phase 3b — the pure cascade-walk core extracted from ConfigResolver:
// first tier with a set (non-null/undefined) value wins; else the code default.
// Ordering + max-scope filtering are the caller's job — this is only the walk.

describe('walkCascade', () => {
  it('returns the first tier with a set value and its source', () => {
    const tiers: CascadeTier<'doctor' | 'tenant'>[] = [
      { source: 'doctor', value: true },
      { source: 'tenant', value: false },
    ];
    expect(walkCascade(tiers, false)).toEqual({ value: true, source: 'doctor' });
  });

  it('skips null/undefined tiers and takes the next set one', () => {
    const tiers: CascadeTier<'doctor' | 'department' | 'tenant'>[] = [
      { source: 'doctor', value: null },
      { source: 'department', value: undefined },
      { source: 'tenant', value: true },
    ];
    expect(walkCascade(tiers, false)).toEqual({ value: true, source: 'tenant' });
  });

  it('treats false / 0 / "" as SET values (not skipped)', () => {
    expect(walkCascade([{ source: 'tenant', value: false }], true)).toEqual({ value: false, source: 'tenant' });
    expect(walkCascade([{ source: 'tenant', value: 0 }], 99)).toEqual({ value: 0, source: 'tenant' });
    expect(walkCascade([{ source: 'tenant', value: '' }], 'x')).toEqual({ value: '', source: 'tenant' });
  });

  it('falls back to the code default when every tier is unset', () => {
    const tiers: CascadeTier<'tenant'>[] = [{ source: 'tenant', value: null }];
    expect(walkCascade(tiers, false)).toEqual({ value: false, source: 'code-default' });
  });

  it('falls back to the code default for an empty tier list', () => {
    expect(walkCascade([], true)).toEqual({ value: true, source: 'code-default' });
  });
});
