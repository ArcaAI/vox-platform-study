/**
 * TASK-1001 — `startRecording` refuses to bind a recording to an STT streaming session that is no
 * longer live.
 *
 * The race (ALaaS "Race 1"): a client retries `start`, and the OLDER `POST :id/recording/start`
 * is still in flight when the newer one completes. If the older request lands last it names an
 * STT session the client has since closed, and HOPE used to bind the consultation's live
 * documentation to it — `stt:result:{staleId}` then never publishes again and the note stalls.
 *
 * The rule pinned here:
 *   - no `sttSessionId` ⇒ nothing to check, bind exactly as before;
 *   - apps/stt reports the session `active` ⇒ bind exactly as before;
 *   - apps/stt reports it `closed` / `finalizing` / `rejected`, or does not know it (404) ⇒ 409
 *     `STT_SESSION_NOT_ACTIVE`, and NOTHING is written (no status change, no sys-event);
 *   - apps/stt cannot be asked (transport error / unwired) ⇒ bind as before: the guard refuses a
 *     session it KNOWS is stale, never one it merely could not check;
 *   - existence and tenancy are resolved FIRST, so a foreign consultation id is still a 404.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationService, STT_SESSION_NOT_ACTIVE_CODE } from '../consultation.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = {
  findWithRelations: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
};
const mockStreamingSessions = { getSessionStatus: vi.fn() };

function makeEntity(overrides: Partial<{ tenantId: string; status: ConsultationStatus }> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: 'c-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-23'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: overrides.status ?? ConsultationStatus.PRIMED,
    degradedReasons: [],
    createdAt: new Date('2026-09-23T00:00:00Z'),
    updatedAt: new Date('2026-09-23T00:00:00Z'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * Positional construction up to the trailing optional `streamingSessions` dependency. `null` means
 * "not wired" (a default parameter would swallow an explicit `undefined`).
 */
function makeService(streamingSessions: unknown = mockStreamingSessions) {
  return new ConsultationService(
    mockConsultationRepository as any,
    {} as any, // departmentRepository
    {} as any, // userRoleAssignmentRepository
    {} as any, // userDepartmentRepository
    {} as any, // userRepository
    mockEventEmitter as any,
    mockClsService as any,
    undefined, // entitlements
    undefined, // harnessAuditService
    undefined, // tenantSettings
    undefined, // workflowDispatchService
    undefined, // consentGrantService
    undefined, // workflowDefinitionRepository
    undefined, // policyEngine
    undefined, // contextSchemaService
    undefined, // userIdentityService
    undefined, // visitTypes
    undefined, // contextService
    (streamingSessions ?? undefined) as any,
  );
}

function sttStatus(status: 'active' | 'finalizing' | 'closed' | 'rejected') {
  return { sessionId: 'stt-new', status, maxConcurrent: 4, currentActive: 1 };
}

describe('ConsultationService.startRecording — TASK-1001 stale STT session guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamingSessions.getSessionStatus.mockReset();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    mockConsultationRepository.findWithRelations.mockResolvedValue(makeEntity());
    mockConsultationRepository.updateWithVersion.mockImplementation(async (_id: string, entity: ConsultationEntity) => entity);
  });

  it('binds an ACTIVE session exactly as before, asking apps/stt with the caller tenant', async () => {
    mockStreamingSessions.getSessionStatus.mockResolvedValue(sttStatus('active'));

    const result = await makeService().startRecording('c-1', { sttSessionId: 'stt-new' });

    expect(mockStreamingSessions.getSessionStatus).toHaveBeenCalledWith('stt-new', 'tenant-1');
    expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(ConsultationStatus.RECORDING);
  });

  it.each(['closed', 'finalizing', 'rejected'] as const)('refuses a %s session with 409 STT_SESSION_NOT_ACTIVE and writes nothing', async (status) => {
    mockStreamingSessions.getSessionStatus.mockResolvedValue(sttStatus(status));

    const error = await makeService()
      .startRecording('c-1', { sttSessionId: 'stt-old' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: STT_SESSION_NOT_ACTIVE_CODE,
      sttSessionId: 'stt-old',
      sttSessionStatus: status,
    });
    expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('refuses a session apps/stt does not know (removed, reaped, or never created) as `unknown`', async () => {
    mockStreamingSessions.getSessionStatus.mockResolvedValue(null);

    const error = await makeService()
      .startRecording('c-1', { sttSessionId: 'stt-gone' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'STT_SESSION_NOT_ACTIVE',
      sttSessionId: 'stt-gone',
      sttSessionStatus: 'unknown',
    });
    expect(mockConsultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('checks nothing when the request names no STT session (the transcript-reread path)', async () => {
    const result = await makeService().startRecording('c-1');

    expect(mockStreamingSessions.getSessionStatus).not.toHaveBeenCalled();
    expect(result.status).toBe(ConsultationStatus.RECORDING);
  });

  it('binds as before when apps/stt cannot be asked — it refuses a KNOWN-stale session, never an unchecked one', async () => {
    mockStreamingSessions.getSessionStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await makeService().startRecording('c-1', { sttSessionId: 'stt-new' });

    expect(result.status).toBe(ConsultationStatus.RECORDING);
    expect(mockConsultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('binds as before when the streaming-session service is not wired', async () => {
    const result = await makeService(null).startRecording('c-1', { sttSessionId: 'stt-new' });
    expect(result.status).toBe(ConsultationStatus.RECORDING);
    expect(mockStreamingSessions.getSessionStatus).not.toHaveBeenCalled();
  });

  it('resolves the consultation FIRST — an unknown or foreign id is a 404, and apps/stt is never asked', async () => {
    mockConsultationRepository.findWithRelations.mockResolvedValue(null);
    await expect(makeService().startRecording('missing', { sttSessionId: 'stt-old' })).rejects.toThrow(NotFoundException);

    mockConsultationRepository.findWithRelations.mockResolvedValue(makeEntity({ tenantId: 'tenant-2' }));
    await expect(makeService().startRecording('c-1', { sttSessionId: 'stt-old' })).rejects.toThrow(NotFoundException);

    expect(mockStreamingSessions.getSessionStatus).not.toHaveBeenCalled();
  });
});
