/**
 * TASK-1036 lane B3b — `GET admin/workflow-definitions/tags?q=&limit=`: tag autocomplete for the
 * workflow management screen. Tenant-only (never SYSTEM rows), normalised lower-case, ranked by how
 * many workflow LINEAGES (slugs) carry the tag, then alphabetically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const where = vi.fn();
const select = vi.fn();
const toList = vi.fn();
const builder = { Where: where, Select: select, ToList: toList };
const mockRepository = { $: vi.fn(() => builder) };
const mockClsService = { get: vi.fn(), set: vi.fn() };

function makeService(): WorkflowDefinitionService {
  return new WorkflowDefinitionService(mockRepository as never, { emit: vi.fn() } as never, mockClsService as never, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  where.mockReturnValue(builder);
  select.mockReturnValue(builder);
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  toList.mockResolvedValue([
    { slug: 'discharge', tags: ['Cardiology', 'notes'] },
    { slug: 'discharge', tags: ['cardiology ', 'Notes'] }, // a second VERSION of the same lineage
    { slug: 'intake', tags: ['notes', 'triage'] },
    { slug: 'triage_v2', tags: ['TRIAGE', null, ''] },
    { slug: 'empty', tags: null },
  ]);
});

describe('listTagSuggestions', () => {
  it('reads only the caller tenant`s non-deleted rows', async () => {
    await makeService().listTagSuggestions({});
    expect(where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(where).toHaveBeenCalledWith({ resourceStatus: { not: 'DELETED' } });
    expect(select).toHaveBeenCalledWith(['slug', 'tags']);
  });

  it('normalises to lower-case and counts LINEAGES, ranked by count then alphabetically', async () => {
    expect(await makeService().listTagSuggestions({})).toEqual([
      { tag: 'notes', count: 2 },
      { tag: 'triage', count: 2 },
      { tag: 'cardiology', count: 1 },
    ]);
  });

  it('`q` is a case-insensitive substring filter', async () => {
    expect(await makeService().listTagSuggestions({ q: '  TRI ' })).toEqual([{ tag: 'triage', count: 2 }]);
  });

  it('`limit` defaults to 20 and is capped at 100', async () => {
    toList.mockResolvedValue(Array.from({ length: 150 }, (_, i) => ({ slug: `s${i}`, tags: [`t${String(i).padStart(3, '0')}`] })));
    expect(await makeService().listTagSuggestions({})).toHaveLength(20);
    expect(await makeService().listTagSuggestions({ limit: 500 })).toHaveLength(100);
    expect(await makeService().listTagSuggestions({ limit: 3 })).toHaveLength(3);
  });

  it('refuses without a tenant context', async () => {
    mockClsService.get.mockReturnValue(undefined);
    await expect(makeService().listTagSuggestions({})).rejects.toBeInstanceOf(BadRequestException);
  });
});
