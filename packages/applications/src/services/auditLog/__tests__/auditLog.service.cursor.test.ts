/**
 * TASK-373 — AuditLogService cursor (keyset) pagination.
 *
 * Behaviour tests for `fetchPageByCursor`, the reference consumer of the
 * generic cursor engine. These assert the keyset query shape, the
 * `hasMore`/`nextCursor` envelope, tenant scoping (identical to the offset
 * path), cursor validation, filter forwarding, and acting-user enrichment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@arcaai/domains';
import { AuditLogService } from '../auditLog.service';
import { decodeCursor, deserializeFilterString } from '../../../common';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockAuditLogRepository = { findAll: vi.fn(), count: vi.fn(), findById: vi.fn(), create: vi.fn() };
const mockUserRepository = { findAll: vi.fn() };
const mockDatabaseService = {
  client: { auditLog: { create: vi.fn() } },
  baseClient: { auditLog: { create: vi.fn() } },
};

// toCursorPage only reads id + createdAt; resolveResponsibleUsers reads
// responsibleUserId. A minimal shape keeps the test focused on behaviour.
const makeEntity = (id: string, createdAt: Date, responsibleUserId: string | null = 'user-123', tenantId = 'tenant-1') =>
  ({ id, createdAt, responsibleUserId, tenantId }) as never;

describe('AuditLogService — cursor pagination (TASK-373)', () => {
  let service: AuditLogService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id' };
        case 'tenantId':
          return 'tenant-1';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });
    mockUserRepository.findAll.mockResolvedValue([]);

    service = new AuditLogService(
      mockAuditLogRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      mockUserRepository as never,
    );
  });

  it('over-fetches limit+1 with a stable (createdAt,id) DESC keyset sort, tenant-scoped', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10 });

    expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 11,
        sort: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
  });

  it('returns hasMore + a nextCursor pointing at the last returned row', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => makeEntity(`id-${i}`, new Date(2026, 0, 1, 0, 0, 11 - i)));
    mockAuditLogRepository.findAll.mockResolvedValue(rows);

    const { page } = await service.fetchPageByCursor({ limit: 10 });

    expect(page.hasMore).toBe(true);
    expect(page.data).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string)?.id).toBe('id-9');
  });

  it('returns no nextCursor on the final (under-filled) page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeEntity(`id-${i}`, new Date(2026, 0, 1, 0, 0, 3 - i)));
    mockAuditLogRepository.findAll.mockResolvedValue(rows);

    const { page } = await service.fetchPageByCursor({ limit: 10 });

    expect(page.hasMore).toBe(false);
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('decodes a supplied cursor into a keyset predicate AND-ed with the tenant scope', async () => {
    const first = Array.from({ length: 11 }, (_, i) => makeEntity(`id-${i}`, new Date(2026, 0, 1, 0, 0, 11 - i)));
    mockAuditLogRepository.findAll.mockResolvedValue(first);
    const { page } = await service.fetchPageByCursor({ limit: 10 });

    mockAuditLogRepository.findAll.mockClear();
    mockAuditLogRepository.findAll.mockResolvedValue([]);
    await service.fetchPageByCursor({ limit: 10, cursor: page.nextCursor as string });

    const call = mockAuditLogRepository.findAll.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({ tenantId: 'tenant-1' }),
          expect.objectContaining({ OR: expect.any(Array) }),
        ]),
      }),
    );
  });

  it('rejects a malformed cursor with BadRequestException (and never queries)', async () => {
    await expect(service.fetchPageByCursor({ cursor: '@@not-a-cursor@@' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockAuditLogRepository.findAll).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when a non-super-admin caller has no tenant scope', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'u', roles: ['Doctor'] } : null));

    await expect(service.fetchPageByCursor({ limit: 10 })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockAuditLogRepository.findAll).not.toHaveBeenCalled();
  });

  it('does NOT scope to a tenant for GLOBAL_ADMIN callers', async () => {
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'sa', roles: ['GLOBAL_ADMIN'] };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10 });

    expect(mockAuditLogRepository.findAll.mock.calls[0][0].where?.tenantId).toBeUndefined();
  });

  it('forwards audit filters into the keyset where clause', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10, action: AuditAction.CREATE, userId: 'user-9' });

    expect(mockAuditLogRepository.findAll.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ tenantId: 'tenant-1', action: AuditAction.CREATE, responsibleUserId: 'user-9' }),
    );
  });

  // TASK-375 §8 follow-up — the cursor (keyset) path must apply the SAME
  // model-aware CSV `filters` coercion as the offset path (fetchAllFiltered):
  // boolean/number/date/enum values arrive as strings in the `field[op]:value`
  // contract and must be coerced against the 'AuditLog' model before reaching
  // Prisma. The coerced map is passed as the `filters` prop (separate from the
  // keyset/tenant `where`), exactly like the offset path threads
  // `withFormattedPaginatedProps`.
  it('coerces CSV filters (boolean/number/date/enum) and passes them as the keyset `filters` prop', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({
      limit: 10,
      filters: 'success[equals]:false;version[gt]:5;createdAt[gte]:2026-01-01;action[equals]:CREATE',
    } as never);

    expect(mockAuditLogRepository.findAll.mock.calls[0][0].filters).toEqual({
      success: { equals: false },
      version: { gt: 5 },
      createdAt: { gte: new Date('2026-01-01') },
      action: { equals: 'CREATE' },
    });
  });

  it('coerces cursor CSV filters IDENTICALLY to the offset deserializer (parity)', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);
    const csv = 'success[equals]:true;version[lte]:9;createdAt[lt]:2026-06-27T12:00:00.000Z;resourceType[equals]:User';

    await service.fetchPageByCursor({ limit: 10, filters: csv } as never);

    expect(mockAuditLogRepository.findAll.mock.calls[0][0].filters).toEqual(deserializeFilterString(csv, 'AuditLog'));
  });

  it('keeps the keyset/tenant `where` separate from the coerced CSV `filters`', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10, action: AuditAction.UPDATE, filters: 'success[equals]:false' } as never);

    const call = mockAuditLogRepository.findAll.mock.calls[0][0];
    // Structured A8 filters + tenant stay on `where`; CSV stays on `filters`.
    expect(call.where).toEqual(expect.objectContaining({ tenantId: 'tenant-1', action: AuditAction.UPDATE }));
    expect(call.filters).toEqual({ success: { equals: false } });
  });

  it('omits `filters` (undefined) when no CSV filters are supplied (back-compat)', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10 });

    expect(mockAuditLogRepository.findAll.mock.calls[0][0].filters).toBeUndefined();
  });

  it('resolves responsible users for the returned page in a single batch (no N+1)', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([makeEntity('id-1', new Date(2026, 0, 1), 'user-123')]);
    mockUserRepository.findAll.mockResolvedValue([
      { id: 'user-123', username: 'jdoe', UserProfile: { firstName: 'Jane', lastName: 'Doe', email: 'jane@x.com' } },
    ]);

    const { responsibleUsers } = await service.fetchPageByCursor({ limit: 10 });

    expect(mockUserRepository.findAll).toHaveBeenCalledTimes(1);
    expect(responsibleUsers['user-123'].displayName).toBe('Jane Doe');
    expect(responsibleUsers['user-123'].email).toBe('jane@x.com');
  });

  it('does not emit any system event (OB-04 — audit reads are never self-audited)', async () => {
    mockAuditLogRepository.findAll.mockResolvedValue([]);

    await service.fetchPageByCursor({ limit: 10 });

    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });
});
