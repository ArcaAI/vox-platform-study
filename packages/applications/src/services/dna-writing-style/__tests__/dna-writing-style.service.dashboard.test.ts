/**
 * DnaWritingStyleService — getDashboard
 *
 * Aggregate dashboard: distinct doctors with a latest report, average current
 * version across latest reports, and recent usage activity from DnaUsageRecord.
 * Mocks only at boundaries: repositories, queue, event emitter, CLS.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { DnaWritingStyleService } from '../dna-writing-style.service';

const createMockClsService = () => ({ get: vi.fn(), set: vi.fn() });
const createMockEventEmitter = () => ({ emit: vi.fn() });

const createMockDnaReportRepository = () => ({
  findById: vi.fn(),
  findLatestForDoctor: vi.fn(),
  findAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  $: vi.fn(),
  countDoctorsWithLatestReport: vi.fn().mockResolvedValue(0),
  averageCurrentVersion: vi.fn().mockResolvedValue(0),
});

const createMockDnaVersionRepository = () => ({ findAll: vi.fn().mockResolvedValue([]), create: vi.fn() });

const createMockDnaUsageRecordRepository = () => ({
  countSince: vi.fn().mockResolvedValue(0),
  getDailyUsageCounts: vi.fn().mockResolvedValue([]),
  findRecent: vi.fn().mockResolvedValue([]),
});

const createMockUserRoleAssignmentRepository = () => ({ findFirst: vi.fn() });
// Membership guard also reads UserDepartment + User.
const createMockUserDepartmentRepository = () => ({ findFirst: vi.fn() });
const createMockUserRepository = () => ({ findFirst: vi.fn() });
const createMockQueue = () => ({ add: vi.fn() });

const createMockUsageEntity = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'usage-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  doctorId: overrides.doctorId ?? 'doctor-1',
  dnaReportId: overrides.dnaReportId ?? 'report-1',
  dnaVersionNumber: 'dnaVersionNumber' in overrides ? overrides.dnaVersionNumber : 2,
  consultationId: overrides.consultationId ?? 'consult-1',
  createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
});

describe('DnaWritingStyleService.getDashboard', () => {
  let service: DnaWritingStyleService;
  let mockReportRepo: ReturnType<typeof createMockDnaReportRepository>;
  let mockVersionRepo: ReturnType<typeof createMockDnaVersionRepository>;
  let mockUsageRepo: ReturnType<typeof createMockDnaUsageRecordRepository>;
  let mockUserRoleAssignmentRepo: ReturnType<typeof createMockUserRoleAssignmentRepository>;
  let mockUserDepartmentRepo: ReturnType<typeof createMockUserDepartmentRepository>;
  let mockUserRepo: ReturnType<typeof createMockUserRepository>;
  let mockQueue: ReturnType<typeof createMockQueue>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;

  const build = () =>
    new DnaWritingStyleService(
      mockReportRepo as never,
      mockVersionRepo as never,
      mockUsageRepo as never,
      mockUserRoleAssignmentRepo as never,
      mockUserDepartmentRepo as never,
      mockUserRepo as never,
      mockQueue as never,
      mockEventEmitter as never,
      mockClsService as never,
    );

  const asTenantAdmin = (tenantId: string | null) =>
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'tenant-admin-1', roles: ['TENANT_ADMIN'] };
      if (key === 'tenantId') return tenantId;
      return null;
    });

  const asGlobalAdmin = (tenantId: string | null) =>
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'super-1', roles: ['SUPER_ADMIN'] };
      if (key === 'tenantId') return tenantId;
      return null;
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockReportRepo = createMockDnaReportRepository();
    mockVersionRepo = createMockDnaVersionRepository();
    mockUsageRepo = createMockDnaUsageRecordRepository();
    mockUserRoleAssignmentRepo = createMockUserRoleAssignmentRepository();
    mockUserDepartmentRepo = createMockUserDepartmentRepository();
    mockUserRepo = createMockUserRepository();
    mockQueue = createMockQueue();
    mockClsService = createMockClsService();
    mockEventEmitter = createMockEventEmitter();
    asTenantAdmin('tenant-1');
    service = build();
  });

  describe('DTO shape', () => {
    it('returns usersWithStyle, avgVersions, and recentActivity', async () => {
      mockReportRepo.countDoctorsWithLatestReport.mockResolvedValue(7);
      mockReportRepo.averageCurrentVersion.mockResolvedValue(2.5);
      mockUsageRepo.countSince.mockResolvedValue(42);
      mockUsageRepo.getDailyUsageCounts.mockResolvedValue([
        { date: '2026-02-17', count: 3 },
        { date: '2026-02-18', count: 5 },
      ]);
      mockUsageRepo.findRecent.mockResolvedValue([createMockUsageEntity({ id: 'usage-9' })]);

      const result = await service.getDashboard();

      expect(result.usersWithStyle).toBe(7);
      expect(result.avgVersions).toBe(2.5);
      expect(result.recentActivity.total).toBe(42);
      expect(result.recentActivity.dailyCounts).toEqual([
        { date: '2026-02-17', count: 3 },
        { date: '2026-02-18', count: 5 },
      ]);
      expect(result.recentActivity.latest).toHaveLength(1);
      expect(result.recentActivity.windowDays).toBeGreaterThan(0);
    });

    it('maps usage entities into serializable latest entries', async () => {
      mockUsageRepo.findRecent.mockResolvedValue([
        createMockUsageEntity({ id: 'usage-9', doctorId: 'doc-9', dnaReportId: 'rep-9', dnaVersionNumber: 4, consultationId: 'c-9' }),
      ]);

      const result = await service.getDashboard();
      const entry = result.recentActivity.latest[0]!;

      expect(entry.id).toBe('usage-9');
      expect(entry.doctorId).toBe('doc-9');
      expect(entry.dnaReportId).toBe('rep-9');
      expect(entry.dnaVersionNumber).toBe(4);
      expect(entry.consultationId).toBe('c-9');
      expect(entry.createdAt).toBe('2026-02-18T10:00:00.000Z');
    });

    it('rounds avgVersions to 2 decimals', async () => {
      mockReportRepo.averageCurrentVersion.mockResolvedValue(2.66666);

      const result = await service.getDashboard();

      expect(result.avgVersions).toBe(2.67);
    });

    it('defaults avgVersions to 0 when there are no reports', async () => {
      mockReportRepo.averageCurrentVersion.mockResolvedValue(0);

      const result = await service.getDashboard();

      expect(result.avgVersions).toBe(0);
      expect(result.usersWithStyle).toBe(0);
      expect(result.recentActivity.latest).toEqual([]);
    });
  });

  describe('tenant scoping', () => {
    it('scopes a TENANT_ADMIN to their CLS tenant', async () => {
      asTenantAdmin('tenant-1');
      service = build();

      await service.getDashboard();

      expect(mockReportRepo.countDoctorsWithLatestReport).toHaveBeenCalledWith('tenant-1');
      expect(mockReportRepo.averageCurrentVersion).toHaveBeenCalledWith('tenant-1');
      expect(mockUsageRepo.findRecent).toHaveBeenCalledWith(expect.any(Number), 'tenant-1');
    });

    it('ignores a requested tenantId override for a TENANT_ADMIN (cannot escape tenant)', async () => {
      asTenantAdmin('tenant-1');
      service = build();

      await service.getDashboard('tenant-OTHER');

      expect(mockReportRepo.countDoctorsWithLatestReport).toHaveBeenCalledWith('tenant-1');
    });

    it('throws BadRequestException when a TENANT_ADMIN has no CLS tenant', async () => {
      asTenantAdmin(null);
      service = build();

      await expect(service.getDashboard()).rejects.toThrow(BadRequestException);
    });

    it('uses the requested tenantId for a global admin', async () => {
      asGlobalAdmin(null);
      service = build();

      await service.getDashboard('tenant-X');

      expect(mockReportRepo.countDoctorsWithLatestReport).toHaveBeenCalledWith('tenant-X');
      expect(mockUsageRepo.countSince).toHaveBeenCalledWith(expect.any(Date), 'tenant-X');
    });

    it('aggregates across all tenants for a global admin with no tenantId', async () => {
      asGlobalAdmin(null);
      service = build();

      await service.getDashboard();

      expect(mockReportRepo.countDoctorsWithLatestReport).toHaveBeenCalledWith(undefined);
      expect(mockUsageRepo.getDailyUsageCounts).toHaveBeenCalledWith(expect.any(Date), undefined);
    });
  });

  it('queries usage within a 30-day window (since ≈ now − 30d)', async () => {
    asTenantAdmin('tenant-1');
    service = build();
    const before = Date.now();

    await service.getDashboard();

    const [sinceArg] = mockUsageRepo.countSince.mock.calls[0]!;
    const since = (sinceArg as Date).getTime();
    const days = (before - since) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    // sanity: ResourceStatusType import keeps the domain enum referenced
    expect(ResourceStatusType.ENABLED).toBeDefined();
  });
});
