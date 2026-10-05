/**
 * ConsultationService — recording lifecycle (Clinical Workflow Playground WS2), re-pinned by
 * TASK-1045.
 *
 * `startRecording` / `stopRecording` are deprecated aliases of `POST :id/start` / `POST :id/stop`:
 * they delegate to `IConsultationLifecycleService`, which routes the change through
 * `ConsultationEntity.transitionTo` (`OPEN | STOPPED | PAUSED → RECORDING`, `RECORDING → STOPPED`),
 * persists via `updateWithVersion` and publishes the lifecycle event. This suite wires the REAL
 * lifecycle service behind the alias, so the alias is pinned end to end.
 *
 * Removed with the states they guarded: the `consultation.state.requirePrimedBeforeRecording`
 * kill-switch (PRIMED is gone — `prime` is a no-op) and the completion-timeout cancel on start (the
 * auto-close sweep owns closing).
 */
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';
import { ConsultationLifecycleService } from '../../lifecycle/consultation-lifecycle.service';
import { encounterServiceDouble } from './consultation-service.fixture';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
// One row store behind both readers: the alias answers through `findWithRelations`, the lifecycle
// service loads through `findByIdOrNull`.
const mockConsultationRepository = {
  findWithRelations: vi.fn(),
  findByIdOrNull: vi.fn(),
  updateWithVersion: vi.fn(),
  touchActivity: vi.fn(),
  setProcessing: vi.fn(),
};
const mockEvents = { publish: vi.fn() };

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
    status: overrides.status ?? ConsultationStatus.OPEN,
    processing: ConsultationProcessing.IDLE,
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

/** Serve `entity` from both readers; every write lands back on it (the database's view). */
function seed(entity: ConsultationEntity | null) {
  mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
  mockConsultationRepository.findByIdOrNull.mockResolvedValue(entity);
}

function makeService() {
  const lifecycle = new ConsultationLifecycleService(
    mockConsultationRepository as any,
    { findBySeq: vi.fn().mockResolvedValue(null), endEncounter: vi.fn().mockResolvedValue(true) } as any, // encounterRepository
    { findFullTranscript: vi.fn().mockResolvedValue(null) } as any, // contextItemRepository
    {} as any, // approvals
    {} as any, // gate
    mockEvents as any,
    mockEventEmitter as any,
    mockClsService as any,
  );
  return new ConsultationService(
    mockConsultationRepository as any,
    {} as any, // departmentRepository
    {} as any, // userRoleAssignmentRepository
    {} as any, // userDepartmentRepository
    {} as any, // userRepository
    mockEventEmitter as any,
    mockClsService as any,
    encounterServiceDouble(mockConsultationRepository as never),
    lifecycle,
  );
}

const publishedTypes = () => mockEvents.publish.mock.calls.map(([, type]) => type);

describe('ConsultationService — recording lifecycle aliases (WS2, TASK-1045 delegation)', () => {
  let service: ConsultationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    mockConsultationRepository.updateWithVersion.mockImplementation(async (_id: string, entity: ConsultationEntity) => entity);
    mockConsultationRepository.touchActivity.mockResolvedValue(true);
    mockConsultationRepository.setProcessing.mockResolvedValue(true);
    mockEvents.publish.mockResolvedValue(undefined);
    service = makeService();
  });

  describe('startRecording', () => {
    it('transitions OPEN → RECORDING, persists via updateWithVersion, publishes `started`', async () => {
      const entity = makeEntity({ status: ConsultationStatus.OPEN, version: 4 });
      seed(entity);

      const result = await service.startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
      expect(entity.status).toBe(ConsultationStatus.RECORDING);
      expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledWith('c-1', entity, 4);
      expect(publishedTypes()).toEqual(['started']);
      expect(entity.lastTransition).toMatchObject({ from: ConsultationStatus.OPEN, to: ConsultationStatus.RECORDING, actor: 'doctor-1' });
    });

    it('a STOPPED consultation resumes recording (the clinician adds more)', async () => {
      const entity = makeEntity({ status: ConsultationStatus.STOPPED });
      seed(entity);

      const result = await service.startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
    });

    it('a CLOSED_INCOMPLETE consultation is not recordable — 409 CONSULTATION_NOT_RECORDABLE, reopen first', async () => {
      seed(makeEntity({ status: ConsultationStatus.CLOSED_INCOMPLETE }));

      const error = await service.startRecording('c-1').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CONSULTATION_NOT_RECORDABLE' });
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when consultation is missing', async () => {
      seed(null);
      await expect(service.startRecording('missing')).rejects.toThrow(NotFoundException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (generic) for a cross-tenant consultation', async () => {
      seed(makeEntity({ tenantId: 'tenant-OTHER' }));
      await expect(service.startRecording('c-1')).rejects.toThrow(NotFoundException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'doctor-1' } : null));
      await expect(service.startRecording('c-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('stopRecording', () => {
    it('transitions RECORDING → STOPPED (no longer recordable as RECORDING), persists, publishes `stopped`', async () => {
      const entity = makeEntity({ status: ConsultationStatus.RECORDING, version: 2 });
      seed(entity);

      const result = await service.stopRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.STOPPED);
      expect(entity.status).toBe(ConsultationStatus.STOPPED);
      expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledWith('c-1', entity, 2);
      expect(publishedTypes()).toContain('stopped');
    });

    it('throws ConflictException (409) stopping a consultation that was never recording', async () => {
      seed(makeEntity({ status: ConsultationStatus.OPEN }));

      await expect(service.stopRecording('c-1')).rejects.toThrow(ConflictException);
      expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when consultation is missing', async () => {
      seed(null);
      await expect(service.stopRecording('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
