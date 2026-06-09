import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { ConsultationStatus } from '@arcaai/domains';
import { AdminConsultationController } from '../admin-consultation.controller';

// TASK-319 F1 — admin (tenant-wide) consultation surface.
//
// The admin controller is the separate-controller (Pattern A) counterpart to
// ConsultationController. It must (a) list EVERY consultation in the tenant via
// the tenant-wide service method (never the caller's doctorId), (b) 404 on a
// missing/cross-tenant id (the Prisma tenant-scope extension nulls cross-tenant
// reads), and (c) be class-gated by @CanManage('Consultation') so plain doctors
// (who only hold owner-scoped list/read) are excluded.

const mockConsultationService = {
  listConsultationsForTenant: vi.fn(),
  getByIdWithRelations: vi.fn(),
};

describe('AdminConsultationController', () => {
  let controller: AdminConsultationController;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller = new AdminConsultationController(mockConsultationService as any);
  });

  describe('list (tenant-wide)', () => {
    it('delegates to listConsultationsForTenant with parsed pagination + filters (never the caller doctorId)', async () => {
      mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 2, limit: 5 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.list({ page: '2', limit: '5', patientId: 'p-1', doctorId: 'd-1', departmentId: 'dept-1' } as any);

      expect(mockConsultationService.listConsultationsForTenant).toHaveBeenCalledWith({
        page: 2,
        pageSize: 5,
        patientId: 'p-1',
        doctorId: 'd-1',
        departmentId: 'dept-1',
      });
    });

    it('defaults page=1 / pageSize=10 when query params are absent', async () => {
      mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.list({} as any);
      expect(mockConsultationService.listConsultationsForTenant).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 10 }),
      );
    });

    // TASK-341 B2 — optional ?status=RECORDING filter (admin live console).
    it('forwards a valid ?status filter (e.g. RECORDING)', async () => {
      mockConsultationService.listConsultationsForTenant.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.list({ status: 'RECORDING' } as any);
      expect(mockConsultationService.listConsultationsForTenant).toHaveBeenCalledWith(
        expect.objectContaining({ status: ConsultationStatus.RECORDING }),
      );
    });

    it('rejects an invalid ?status value with BadRequestException', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(controller.list({ status: 'NOPE' } as any)).rejects.toThrow(BadRequestException);
      expect(mockConsultationService.listConsultationsForTenant).not.toHaveBeenCalled();
    });
  });

  describe('getById (tenant-scoped read)', () => {
    it('returns the consultation when the service resolves it', async () => {
      const consultation = { id: 'c-1', tenantId: 't-1' };
      mockConsultationService.getByIdWithRelations.mockResolvedValue(consultation);

      const result = await controller.getById('c-1');

      expect(result).toBe(consultation);
      expect(mockConsultationService.getByIdWithRelations).toHaveBeenCalledWith('c-1');
    });

    it('throws NotFoundException when the service returns null (cross-tenant id filtered by the Prisma extension)', async () => {
      mockConsultationService.getByIdWithRelations.mockResolvedValue(null);
      await expect(controller.getById('other-tenant-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('access gate', () => {
    it('is class-gated by @CanManage(Consultation) so plain doctors are excluded', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AdminConsultationController) as
        | Array<{ action: string; subject: string }>
        | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'Consultation' }]);
    });
  });
});
