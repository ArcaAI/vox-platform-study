/**
 * TASK-983 R1/R4 — `AiModelService.list` must honour the standard
 * `PaginatedQuery` contract.
 *
 * The defect: `list(page, limit)` took ONLY the two pagination numbers and
 * hardcoded `sort: [{ name: 'asc' }]` with no `search`, `searchFields` or
 * `filters`. The console (`features/ai-models`, `useAdminGridParams`) sends all
 * of them, so every facet chip, every sort click and the omni search were
 * discarded SILENTLY — `…?search=zzzz-no-such-model` answered the same 33 rows
 * as the unfiltered call, and a freshly registered model landed off-screen
 * because the grid's own ordering was never applied server-side.
 *
 * The SYSTEM-tenant pin and the platform-admin gate are part of the contract
 * and are asserted here too: a caller-supplied `tenantId` filter can never
 * widen the read, and the registry stays a super-admin plane.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';

const BASE_CLIENT = { __lane: 'base' };

function makeCls(roles: string[] = ['SUPER_ADMIN']) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'user-1', roles };
      if (key === 'tenantId') return 'tenant-working';
      return null;
    }),
    set: vi.fn(),
  };
}

function makeService(roles: string[] = ['SUPER_ADMIN']) {
  const repo = {
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  const emitter = { emit: vi.fn() };
  const db = { baseClient: BASE_CLIENT };
  const service = new AiModelService(repo as never, db as never, emitter as never, makeCls(roles) as never);
  return { service, repo };
}

describe('AiModelService.list — the PaginatedQuery contract (TASK-983 R1/R4)', () => {
  it('forwards the omni search and its search fields to BOTH the page read and the count', async () => {
    const { service, repo } = makeService();

    await service.list({ page: 1, limit: 25, search: 'zzzz-no-such-model', searchFields: 'name,slug' });

    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'zzzz-no-such-model', searchFields: ['name', 'slug'] }),
    );
    // The envelope's `total` must describe the SAME result set the page came
    // from — a count that ignores the search reports 33 for an empty page.
    expect(repo.count).toHaveBeenCalledWith(expect.objectContaining({ search: 'zzzz-no-such-model', searchFields: ['name', 'slug'] }));
  });

  it('honours an explicit sort instead of the hardcoded name:asc', async () => {
    const { service, repo } = makeService();

    await service.list({ page: 1, limit: 3, sort: 'name:desc' });

    expect(repo.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: [{ name: 'desc' }] }));
  });

  it("keeps name:asc as the effective sort when the caller sends none (the console's implicit default)", async () => {
    const { service, repo } = makeService();

    await service.list({ page: 1, limit: 25 });

    expect(repo.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: [{ name: 'asc' }] }));
  });

  it('deserializes the bracket filter grammar the grid emits, on the page read and the count alike', async () => {
    const { service, repo } = makeService();

    await service.list({
      page: 1,
      limit: 25,
      filters: 'deploymentKind[in]:CLOUD|SELF_HOSTED;libraryName[iequals]:whisper.cpp',
    });

    const props = repo.findAll.mock.calls[0][0];
    expect(props.filters).toMatchObject({
      deploymentKind: { in: ['CLOUD', 'SELF_HOSTED'] },
      libraryName: { equals: 'whisper.cpp', mode: 'insensitive' },
    });
    const countProps = repo.count.mock.calls[0][0];
    expect(countProps.filters).toMatchObject({ deploymentKind: { in: ['CLOUD', 'SELF_HOSTED'] } });
  });

  it('pins the read to the SYSTEM tenant even when the caller names another one in `filters`', async () => {
    const { service, repo } = makeService();

    await service.list({ page: 1, limit: 25, filters: 'tenantId[equals]:50000000-0000-0000-0000-000000000000' });

    expect(repo.findAll.mock.calls[0][0].filters).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    expect(repo.count.mock.calls[0][0].filters).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
  });

  it('rejects an enum member the catalogue does not declare with a 400, not a Prisma 500', async () => {
    const { service, repo } = makeService();

    await expect(service.list({ page: 1, limit: 25, filters: 'availability[equals]:NOT_A_MEMBER' })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findAll).not.toHaveBeenCalled();
  });

  it('echoes the requested page/limit and derives totalPages from the FILTERED count', async () => {
    const { service, repo } = makeService();
    repo.count.mockResolvedValue(7);

    const result = await service.list({ page: 2, limit: 3, search: 'whisper', searchFields: 'name' });

    expect(repo.findAll).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 3 }));
    expect(result).toMatchObject({ total: 7, page: 2, limit: 3, totalPages: 3 });
  });

  it('stays platform-admin only — a tenant admin is refused before the repository is touched', async () => {
    const { service, repo } = makeService(['TENANT_ADMIN']);

    await expect(service.list({ page: 1, limit: 25 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findAll).not.toHaveBeenCalled();
  });
});
