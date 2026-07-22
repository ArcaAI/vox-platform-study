/**
 * AuditLogService filtered-list + export unit tests.
 *
 * Focus areas (RED → GREEN):
 * - filters are pushed to the repository `where` clause (NOT in-memory)
 * - tenant scoping mirrors the existing fetch methods (CLS tenant / GLOBAL_ADMIN bypass)
 * - acting users are resolved once per page (deduped) and returned as a map
 * - export materialises the full filtered set (capped, newest-first)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLogService } from '../auditLog.service';
import { AuditAction, ResourceType } from '@arcaai/domains';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockAuditLogRepository = {
  findAll: vi.fn(),
  count: vi.fn(),
};

const mockUserRepository = {
  findAll: vi.fn(),
};

const mockDatabaseService = {
  client: { auditLog: { create: vi.fn() } },
  baseClient: { auditLog: { create: vi.fn() } },
};

const makeAuditRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'audit-1',
  tenantId: 'tenant-1',
  responsibleUserId: 'user-123',
  responsibleIp: '10.0.0.1',
  resourceType: ResourceType.User,
  resourceId: 'res-1',
  action: AuditAction.CREATE,
  eventType: 'RESOURCE',
  success: true,
  data: { name: 'Test' },
  previousData: null,
  metadata: null,
  createdAt: new Date('2026-02-01T10:00:00.000Z'),
  updatedAt: new Date('2026-02-01T10:00:00.000Z'),
  ...overrides,
});

const makeUser = (id: string, firstName: string | null, lastName: string | null, email: string | null, username = 'jdoe') => ({
  id,
  username,
  UserProfile: { firstName, lastName, email },
});

describe('AuditLogService — filtered list + export', () => {
  let service: AuditLogService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id', roles: ['Doctor'] };
        case 'tenantId':
          return 'tenant-1';
        case 'requestIp':
          return '10.0.0.1';
        default:
          return null;
      }
    });

    mockAuditLogRepository.findAll.mockResolvedValue([]);
    mockAuditLogRepository.count.mockResolvedValue(0);
    mockUserRepository.findAll.mockResolvedValue([]);

    service = new AuditLogService(
      mockAuditLogRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockDatabaseService as any,
      mockUserRepository as any,
    );
  });

  describe('fetchAllFiltered — where clause from filters', () => {
    it('pushes from/to/action/resourceType/userId into the repository where (not in-memory)', async () => {
      await service.fetchAllFiltered({
        page: 1,
        limit: 20,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T23:59:59.999Z',
        action: AuditAction.UPDATE,
        resourceType: ResourceType.Consultation,
        userId: 'user-xyz',
      });

      const findAllArg = mockAuditLogRepository.findAll.mock.calls[0][0];
      expect(findAllArg.where).toEqual({
        tenantId: 'tenant-1',
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-01-31T23:59:59.999Z'),
        },
        action: AuditAction.UPDATE,
        resourceType: ResourceType.Consultation,
        responsibleUserId: 'user-xyz',
      });

      const countArg = mockAuditLogRepository.count.mock.calls[0][0];
      expect(countArg.where).toEqual(findAllArg.where);
    });

    it('omits absent filters and only emits a partial range when one bound is given', async () => {
      await service.fetchAllFiltered({ page: 1, limit: 10, from: '2026-03-01T00:00:00.000Z' });

      const findAllArg = mockAuditLogRepository.findAll.mock.calls[0][0];
      expect(findAllArg.where).toEqual({
        tenantId: 'tenant-1',
        createdAt: { gte: new Date('2026-03-01T00:00:00.000Z') },
      });
      expect(findAllArg.where.action).toBeUndefined();
      expect(findAllArg.where.resourceType).toBeUndefined();
      expect(findAllArg.where.responsibleUserId).toBeUndefined();
    });

    it('scopes to the caller tenant for a non-super-admin (empty filters)', async () => {
      await service.fetchAllFiltered({ page: 1, limit: 10 });
      const findAllArg = mockAuditLogRepository.findAll.mock.calls[0][0];
      expect(findAllArg.where).toEqual({ tenantId: 'tenant-1' });
    });

    it('does NOT inject tenantId for a GLOBAL_ADMIN caller', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: 'super-admin-id', roles: ['GLOBAL_ADMIN'] };
          case 'tenantId':
            return 'tenant-1';
          default:
            return null;
        }
      });

      await service.fetchAllFiltered({ page: 1, limit: 10, action: AuditAction.DELETE });
      const findAllArg = mockAuditLogRepository.findAll.mock.calls[0][0];
      expect(findAllArg.where.tenantId).toBeUndefined();
      expect(findAllArg.where.action).toBe(AuditAction.DELETE);
    });
  });

  describe('fetchAllFiltered — acting-user enrichment', () => {
    it('resolves distinct responsibleUserIds in ONE query and maps id → label', async () => {
      mockAuditLogRepository.findAll.mockResolvedValue([
        makeAuditRow({ id: 'a1', responsibleUserId: 'u1' }),
        makeAuditRow({ id: 'a2', responsibleUserId: 'u2' }),
        makeAuditRow({ id: 'a3', responsibleUserId: 'u1' }),
        makeAuditRow({ id: 'a4', responsibleUserId: null }),
      ]);
      mockAuditLogRepository.count.mockResolvedValue(4);
      mockUserRepository.findAll.mockResolvedValue([
        makeUser('u1', 'Alice', 'Nguyen', 'alice@example.com'),
        makeUser('u2', null, null, null, 'bob_user'),
      ]);

      const { result, responsibleUsers } = await service.fetchAllFiltered({ page: 1, limit: 10 });

      // single batch lookup, deduped ids, nulls dropped
      expect(mockUserRepository.findAll).toHaveBeenCalledTimes(1);
      expect(mockUserRepository.findAll.mock.calls[0][0].where).toEqual({ id: { in: ['u1', 'u2'] } });

      expect(responsibleUsers['u1']).toMatchObject({
        id: 'u1',
        displayName: 'Alice Nguyen',
        email: 'alice@example.com',
      });
      // falls back to username when profile name is absent
      expect(responsibleUsers['u2']).toMatchObject({ id: 'u2', displayName: 'bob_user', email: null });
      expect(result.count).toBe(4);
      expect(result.data).toHaveLength(4);
    });

    it('returns an empty user map when the page has no rows', async () => {
      const { responsibleUsers } = await service.fetchAllFiltered({ page: 1, limit: 10 });
      expect(responsibleUsers).toEqual({});
      expect(mockUserRepository.findAll).not.toHaveBeenCalled();
    });
  });

  describe('exportFiltered', () => {
    it('loads the full filtered set capped and ordered newest-first', async () => {
      mockAuditLogRepository.findAll.mockResolvedValue([makeAuditRow({ id: 'a1', responsibleUserId: 'u1' })]);
      mockUserRepository.findAll.mockResolvedValue([makeUser('u1', 'Alice', 'Nguyen', 'alice@example.com')]);

      const { rows, responsibleUsers } = await service.exportFiltered({
        action: AuditAction.LOGIN,
        from: '2026-01-01T00:00:00.000Z',
      });

      const findAllArg = mockAuditLogRepository.findAll.mock.calls[0][0];
      expect(findAllArg.where).toEqual({
        tenantId: 'tenant-1',
        action: AuditAction.LOGIN,
        createdAt: { gte: new Date('2026-01-01T00:00:00.000Z') },
      });
      expect(findAllArg.sort).toEqual([{ createdAt: 'desc' }]);
      expect(findAllArg.limit).toBeGreaterThanOrEqual(10000);

      expect(rows).toHaveLength(1);
      expect(responsibleUsers['u1'].displayName).toBe('Alice Nguyen');
    });
  });
});
