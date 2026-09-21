import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConsultationStatus } from '@arcaai/domains';
import { AdminConsultationController } from '../admin-consultation.controller';

/**
 * TASK-999 — `GET /admin/consultations` gains a server-side `?sort=field:asc|desc`
 * param (wire format shared with the admin-console grid codec,
 * `apps/admin-console/src/shared/data/grid-url-state.ts`).
 *
 * The allow-list lives in `parseConsultationSort`
 * (`@arcaai/applications` `dto/consultation-sort.ts`) and is enforced HERE, in
 * the controller: `@Query() query: PaginatedQuery & {...}` is a hand-typed
 * intersection, which collapses to `Object` for Nest's `design:paramtypes`
 * metadata, so the global `ValidationPipe`'s class-validator pass never runs
 * on it — rejection has to be imperative, exactly like the existing `status`
 * filter's `parseStatus`.
 */

const mockConsultationService = {
  listConsultationsForTenant: vi.fn(),
  getByIdWithRelations: vi.fn(),
};

describe('AdminConsultationController — sort (TASK-999)', () => {
  let controller: AdminConsultationController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AdminConsultationController(mockConsultationService as any);
  });

  // RED before this change: `query.sort` was never read at all, so a valid
  // sort value was silently dropped on the floor.
  it('parses a valid ?sort into { field, direction } and forwards it to the service', async () => {
    mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });

    await controller.list({ sort: 'updatedAt:desc' } as any);

    expect(mockConsultationService.listConsultationsForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ sort: { field: 'updatedAt', direction: 'desc' } }),
    );
  });

  // RED before this change: there was no rejection path at all — `parseConsultationSort`
  // and the allow-list did not exist, so an unknown field could only ever be a
  // latent "arbitrary Prisma orderBy key" bug, never a 400.
  it('rejects an unknown sort field with BadRequestException, never falls back or reaches the service', async () => {
    await expect(controller.list({ sort: 'patientId:asc' } as any)).rejects.toThrow(BadRequestException);
    expect(mockConsultationService.listConsultationsForTenant).not.toHaveBeenCalled();
  });

  it('rejects a malformed sort token (missing direction) with BadRequestException', async () => {
    await expect(controller.list({ sort: 'updatedAt' } as any)).rejects.toThrow(BadRequestException);
    expect(mockConsultationService.listConsultationsForTenant).not.toHaveBeenCalled();
  });

  // RED before this change: absent `sort` produced no `sort` key in the call to
  // the service at all (the OLD default — appointmentDate desc — was hardcoded
  // inside the service, not expressed as a controller contract). This pins the
  // NEW boundary: the controller passes `undefined` through, and the SERVICE
  // (not the controller) supplies DEFAULT_CONSULTATION_SORT.
  it('leaves sort undefined when the query omits it', async () => {
    mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });

    await controller.list({} as any);

    const callArg = mockConsultationService.listConsultationsForTenant.mock.calls[0][0];
    expect(callArg.sort).toBeUndefined();
  });

  // RED before this change: there was no sort handling at all, so a request
  // combining an existing filter (?status=RECORDING) with a sort had no way to
  // prove both reach the service intact — this is the "sorting does not disturb
  // existing filters" case.
  it('forwards both an existing filter and a sort from the same request', async () => {
    mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });

    await controller.list({ status: 'RECORDING', sort: 'status:asc' } as any);

    expect(mockConsultationService.listConsultationsForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ConsultationStatus.RECORDING,
        sort: { field: 'status', direction: 'asc' },
      }),
    );
  });
});
