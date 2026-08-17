import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ChangelogController } from '../changelog.controller';
import { ChangelogAdminController } from '../changelog-admin.controller';

const makeService = () => ({
  list: vi.fn().mockResolvedValue({ data: [], count: 0, page: 0, limit: 10 }),
  listUnseen: vi.fn().mockResolvedValue([]),
  acknowledge: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue({ id: 'e1' }),
  update: vi.fn().mockResolvedValue({ id: 'e1' }),
  publish: vi.fn().mockResolvedValue({ id: 'e1' }),
});

describe('ChangelogController — reader surface', () => {
  let service: ReturnType<typeof makeService>;
  let controller: ChangelogController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
    controller = new ChangelogController(service as never);
  });

  it('delegates list, passing the query through (including `version`)', async () => {
    await controller.list({ page: 1, severity: undefined, version: '2.1' } as never);
    expect(service.list).toHaveBeenCalledWith({ page: 1, severity: undefined, version: '2.1' });
  });

  it('returns whatever listUnseen yields, including the empty case', async () => {
    await expect(controller.listUnseen()).resolves.toEqual([]);
  });

  it('acknowledge forwards only the ids and resolves void (204)', async () => {
    await expect(controller.acknowledge({ entryIds: ['a', 'b'] } as never)).resolves.toBeUndefined();
    expect(service.acknowledge).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('ChangelogAdminController — SUPER_ADMIN-only (imperative gate in the service)', () => {
  let service: ReturnType<typeof makeService>;
  let controller: ChangelogAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
    controller = new ChangelogAdminController(service as never);
  });

  it('a non-super-admin is rejected from EVERY admin route', async () => {
    // The controller holds no role logic of its own by design — the real gate
    // is `ChangelogService.assertSuperAdmin()`. Assert the 403 it raises
    // propagates unchanged from every route (nothing swallows or remaps it).
    const forbidden = new ForbiddenException('Only a super administrator may author release notes');
    service.create.mockRejectedValue(forbidden);
    service.update.mockRejectedValue(forbidden);
    service.publish.mockRejectedValue(forbidden);

    await expect(controller.create({} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.update('e1', {} as never, 1)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.publish('e1', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('folds the If-Match version into the update DTO', async () => {
    await controller.update('e1', { title: 't' } as never, 7);
    expect(service.update).toHaveBeenCalledWith('e1', { title: 't', expectedVersion: 7 });
  });

  it('leaves the DTO untouched when no If-Match version was parsed', async () => {
    await controller.update('e1', { title: 't' } as never, undefined);
    expect(service.update).toHaveBeenCalledWith('e1', { title: 't' });
  });

  it('publish passes the If-Match version straight through', async () => {
    await controller.publish('e1', 3);
    expect(service.publish).toHaveBeenCalledWith('e1', 3);
  });
});
