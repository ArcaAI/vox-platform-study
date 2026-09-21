/**
 * ConsultationService.listConsultationsForTenant — server-side sort (TASK-999)
 *
 * The route is reached only via `AdminConsultationController#list`, which
 * parses+validates the raw `?sort=field:asc|desc` query string
 * (`parseConsultationSort` / `dto/consultation-sort.ts`) BEFORE calling the
 * service — so at THIS layer `sort` always arrives pre-validated
 * (`ConsultationSort | undefined`), never a raw string. These tests cover
 * what the service itself owns: turning that value (or its absence) into the
 * repository's `orderBy` array, without disturbing the existing filters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';
import { ConsultationStatus } from '@arcaai/domains';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockConsultationRepository = {
  findPaginatedWithRelations: vi.fn(),
  count: vi.fn(),
};

const mockDepartmentRepository = { findById: vi.fn() };
const mockUserRoleAssignmentRepository = { findFirst: vi.fn() };
const mockUserDepartmentRepository = { findFirst: vi.fn() };
const mockUserRepository = { findFirst: vi.fn() };

describe('ConsultationService.listConsultationsForTenant — sort (TASK-999)', () => {
  let service: ConsultationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-id-1' };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });
    mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
    mockConsultationRepository.count.mockResolvedValue(0);

    service = new ConsultationService(
      mockConsultationRepository as any,
      mockDepartmentRepository as any,
      mockUserRoleAssignmentRepository as any,
      mockUserDepartmentRepository as any,
      mockUserRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  // RED before this change: `params` had no `sort` field at all, and the
  // repository call always hardcoded `sort: [{ appointmentDate: 'desc' }]` —
  // this assertion failed against that hardcoded order.
  it('orders by the given field/direction — sort={field:updatedAt, direction:desc}', async () => {
    await service.listConsultationsForTenant({
      page: 1,
      pageSize: 10,
      sort: { field: 'updatedAt', direction: 'desc' },
    });

    expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ updatedAt: 'desc' }] }),
    );
  });

  // RED before this change: the only default was the hardcoded
  // `[{ appointmentDate: 'desc' }]` — this pins the NEW contract (updatedAt
  // descending) TASK-999 requires when `sort` is absent.
  it('defaults to updatedAt descending when sort is absent', async () => {
    await service.listConsultationsForTenant({ page: 1, pageSize: 10 });

    expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ updatedAt: 'desc' }] }),
    );
  });

  // RED before this change: `sort` was not a recognized param at all, so there
  // was no way to prove a filter and a sort compose rather than one clobbering
  // the other — this is the "sorting does not disturb existing filters" case.
  it('keeps existing filters intact when a sort is also given', async () => {
    await service.listConsultationsForTenant({
      page: 2,
      pageSize: 5,
      patientId: 'patient-9',
      status: ConsultationStatus.RECORDING,
      sort: { field: 'status', direction: 'asc' },
    });

    expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 5,
        sort: [{ status: 'asc' }],
        filters: { tenantId: 'tenant-1', patientId: 'patient-9', status: ConsultationStatus.RECORDING },
      }),
    );
  });
});
