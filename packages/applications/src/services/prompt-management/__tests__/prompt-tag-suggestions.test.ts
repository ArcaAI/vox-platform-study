/**
 * TASK-1036 R1 — GET admin/prompt-templates/tags: distinct tags over the CALLER tenant's
 * non-deleted prompt templates, ranked count desc then alphabetical.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PromptManagementService } from '../prompt-management.service';

function build(tags: string[][], tenantId: string | null = 'tenant-1') {
  const qb = {
    Where: vi.fn().mockReturnThis(),
    Select: vi.fn().mockReturnThis(),
    ToList: vi.fn().mockResolvedValue(tags.map((t) => ({ tags: t }))),
  };
  const repo = { $: vi.fn().mockReturnValue(qb) };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : null)) };
  const service = new PromptManagementService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    cls as never,
    {} as never,
  );
  return { service, qb, repo };
}

describe('listTagSuggestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads only the caller tenant (explicit pin, no SYSTEM rows) and selects tags only', async () => {
    const { service, qb } = build([['a']]);
    await service.listTagSuggestions({});
    expect(qb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(qb.Select).toHaveBeenCalledWith(['tags']);
  });

  it('refuses a call with no tenant context', async () => {
    const { service } = build([], null);
    await expect(service.listTagSuggestions({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('counts per tag, ranked count desc then alphabetical', async () => {
    const { service } = build([['pre-summary', 'text-v1'], ['text-v1', 'b-tag'], ['text-v1', 'a-tag'], ['pre-summary']]);
    expect(await service.listTagSuggestions({})).toEqual([
      { tag: 'text-v1', count: 3 },
      { tag: 'pre-summary', count: 2 },
      { tag: 'a-tag', count: 1 },
      { tag: 'b-tag', count: 1 },
    ]);
  });

  it('counts a tag once per template even when a row repeats it', async () => {
    const { service } = build([['x', 'x']]);
    expect(await service.listTagSuggestions({})).toEqual([{ tag: 'x', count: 1 }]);
  });

  it('filters by a case-insensitive substring q', async () => {
    const { service } = build([['dept:Cardiology', 'text-v1'], ['dept:renal']]);
    expect((await service.listTagSuggestions({ q: 'CARD' })).map((s) => s.tag)).toEqual(['dept:Cardiology']);
  });

  it('defaults the limit to 20 and caps it at 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => [`t${String(i).padStart(3, '0')}`]);
    const { service } = build(many);
    expect(await service.listTagSuggestions({})).toHaveLength(20);
    expect(await service.listTagSuggestions({ limit: 500 })).toHaveLength(100);
    expect(await service.listTagSuggestions({ limit: 5 })).toHaveLength(5);
    expect(await service.listTagSuggestions({ limit: 0 })).toHaveLength(20);
  });

  it('ignores rows with null/missing tags', async () => {
    const { service, qb } = build([]);
    qb.ToList.mockResolvedValue([{ tags: null }, {}, { tags: ['ok'] }]);
    expect(await service.listTagSuggestions({})).toEqual([{ tag: 'ok', count: 1 }]);
  });
});
