import { describe, it, expect } from 'vitest';

import { findCategoryDefault, partitionAvailablePrompts } from '../partition';
import type { AvailablePrompt } from '../../api/prompts';

function mk(over: Partial<AvailablePrompt> & { id: string }): AvailablePrompt {
  return {
    name: over.id,
    category: 'SUMMARY',
    content: 'content',
    currentVersionNumber: 1,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    ...over,
  } as AvailablePrompt;
}

describe('partitionAvailablePrompts', () => {
  it('splits caller-owned personals (USER_PERSONAL) from read-only defaults', () => {
    const list = [mk({ id: 'a', scope: 'USER_PERSONAL' }), mk({ id: 'b', scope: 'TENANT_DEFAULT' }), mk({ id: 'c', scope: 'DEPARTMENT_DEFAULT' })];
    const { personal, defaults } = partitionAvailablePrompts(list);
    expect(personal.map((p) => p.id)).toEqual(['a']);
    expect(defaults.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('treats a missing scope as a default (never editable)', () => {
    const { personal, defaults } = partitionAvailablePrompts([mk({ id: 'x' })]);
    expect(personal).toEqual([]);
    expect(defaults.map((p) => p.id)).toEqual(['x']);
  });

  it('handles undefined input', () => {
    expect(partitionAvailablePrompts(undefined)).toEqual({ personal: [], defaults: [] });
  });
});

describe('findCategoryDefault', () => {
  it('finds a non-personal default sharing the personal prompt category', () => {
    const personal = mk({ id: 'p', scope: 'USER_PERSONAL', category: 'SUMMARY' });
    const list = [
      personal,
      mk({ id: 'd', scope: 'TENANT_DEFAULT', category: 'SUMMARY' }),
      mk({ id: 'o', scope: 'TENANT_DEFAULT', category: 'CUSTOM' }),
    ];
    expect(findCategoryDefault(personal, list)?.id).toBe('d');
  });

  it('returns undefined when no same-category default exists', () => {
    const personal = mk({ id: 'p', scope: 'USER_PERSONAL', category: 'SUMMARY' });
    expect(findCategoryDefault(personal, [personal])).toBeUndefined();
  });
});
