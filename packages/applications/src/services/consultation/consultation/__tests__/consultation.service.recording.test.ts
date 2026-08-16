/**
 * ConsultationService — recording lifecycle (Clinical Workflow Playground WS2)
 *
 * TASK-711 — verifies `startRecording`/`stopRecording` route through
 * `ConsultationEntity.transitionTo` (`PRIMED → RECORDING`,
 * `RECORDING → DRAINING`), persist via `updateWithVersion`, broadcast
 * `ResourceUpdated`, and surface the column value via
 * `ConsultationResponse.status`. `startRecording` also exercises the ONE
 * flagged precondition in the whole matrix
 * (`consultation.state.requirePrimedBeforeRecording`).
 */
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = {
  findWithRelations: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
};
const mockDepartmentRepository = {};
const mockUserRoleAssignmentRepository = {};
const mockUserDepartmentRepository = {};
const mockUserRepository = {};

function makeEntity(overrides: Partial<{ id: string; tenantId: string; status: ConsultationStatus; version: number }> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: overrides.id ?? 'c-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-06-08'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: overrides.status ?? ConsultationStatus.PRIMED,
    degradedReasons: [],
    createdAt: new Date('2026-06-08T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: overrides.version ?? 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function makeService(tenantSettings?: { resolvePlatform: (key: string) => { value: boolean } }) {
  return new ConsultationService(
    mockConsultationRepository as any,
    mockDepartmentRepository as any,
    mockUserRoleAssignmentRepository as any,
    mockUserDepartmentRepository as any,
    mockUserRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    undefined, // entitlements
    undefined, // harnessAuditService
    tenantSettings as any,
  );
}

describe('ConsultationService — recording lifecycle (WS2, TASK-711)', () => {
  let service: ConsultationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    service = makeService();
  });

  describe('startRecording', () => {
    it('transitions PRIMED → RECORDING, persists via updateWithVersion, emits ResourceUpdated', async () => {
      const entity = makeEntity({ status: ConsultationStatus.PRIMED, version: 4 });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
      mockConsultationRepository.updateWithVersion.mockResolvedValue(entity);

      const result = await service.startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
      expect(entity.status).toBe(ConsultationStatus.RECORDING);
      expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledWith('c-1', entity, 4);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'c-1',
          data: expect.objectContaining({ action: 'startRecording', status: ConsultationStatus.RECORDING }),
        }),
      );
    });

    it('kill-switch OFF (default): a never-primed consultation still starts recording (legacy caller, logged not blocked)', async () => {
      const entity = makeEntity({ status: ConsultationStatus.OPEN });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
      mockConsultationRepository.updateWithVersion.mockResolvedValue(entity);

      const result = await service.startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
      expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalled();
    });

    it('kill-switch ON: a never-primed consultation is rejected with 409', async () => {
      service = makeService({ resolvePlatform: () => ({ value: true }) });
      const entity = makeEntity({ status: ConsultationStatus.OPEN });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);

      await expect(service.startRecording('c-1')).rejects.toThrow(ConflictException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('kill-switch ON: a PRIMED consultation still starts recording', async () => {
      service = makeService({ resolvePlatform: () => ({ value: true }) });
      const entity = makeEntity({ status: ConsultationStatus.PRIMED });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
      mockConsultationRepository.updateWithVersion.mockResolvedValue(entity);

      const result = await service.startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
    });

    it('throws NotFoundException when consultation is missing', async () => {
      mockConsultationRepository.findWithRelations.mockResolvedValue(null);
      await expect(service.startRecording('missing')).rejects.toThrow(NotFoundException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (generic) for a cross-tenant consultation', async () => {
      mockConsultationRepository.findWithRelations.mockResolvedValue(makeEntity({ tenantId: 'tenant-OTHER' }));
      await expect(service.startRecording('c-1')).rejects.toThrow(NotFoundException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'doctor-1' } : null));
      await expect(service.startRecording('c-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('stopRecording', () => {
    it('transitions RECORDING → DRAINING (no longer OPEN), persists, emits ResourceUpdated', async () => {
      const entity = makeEntity({ status: ConsultationStatus.RECORDING });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
      mockConsultationRepository.updateWithVersion.mockResolvedValue(entity);

      const result = await service.stopRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.DRAINING);
      expect(entity.status).toBe(ConsultationStatus.DRAINING);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ action: 'stopRecording', status: ConsultationStatus.DRAINING }) }),
      );
    });

    it('throws ConflictException (409) stopping a consultation that was never recording', async () => {
      const entity = makeEntity({ status: ConsultationStatus.OPEN });
      mockConsultationRepository.findWithRelations.mockResolvedValue(entity);

      await expect(service.stopRecording('c-1')).rejects.toThrow(ConflictException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when consultation is missing', async () => {
      mockConsultationRepository.findWithRelations.mockResolvedValue(null);
      await expect(service.stopRecording('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
