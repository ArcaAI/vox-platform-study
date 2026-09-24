/**
 * TASK-1003 (F-8 / OD-3) — a `recording/start` that names a DIFFERENT live STT session supersedes
 * the previous one: exactly one live STT session belongs to a consultation, and the last writer
 * wins.
 *
 * Live documentation re-binds (and announces the superseded session) itself when this process
 * holds the consultation's live session. This suite pins the FALLBACK the service owns for every
 * other case — a restarted gateway, another replica, the live-documentation kill-switch — where
 * the only binding left is durable: the consultation's open STREAMING `TranscriptionJob` rows.
 *
 * The rules pinned here:
 *   - only when the caller asks for it (`supersedeByDurableBinding`), and only after the
 *     RECORDING write succeeded — a refused start supersedes nothing;
 *   - a row is a candidate only while apps/stt reports its session `active` (rows are best-effort
 *     and can outlive their session) and only when it is OLDER than the new session's own row, so
 *     two racing starts can never supersede each other;
 *   - the new session itself is never superseded, and a re-sent session id supersedes nothing;
 *   - each superseded session is announced ONCE with the pinned payload, and nothing here
 *     cancels it — the listener finalizes it through the normal teardown;
 *   - a failed row read or status lookup never fails the start.
 */
import { ConflictException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType, TranscriptionJobType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';
import { STT_SESSION_SUPERSEDED_EVENT } from '../stt-session-superseded.event';

const TENANT = 'tenant-1';
const CID = 'c-1';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = {
  findWithRelations: vi.fn(),
  updateWithVersion: vi.fn(),
};
const mockStreamingSessions = { getSessionStatus: vi.fn() };
const mockTranscriptionJobs = { findAll: vi.fn() };

function makeEntity(status: ConsultationStatus = ConsultationStatus.RECORDING): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-24'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status,
    degradedReasons: [],
    createdAt: new Date('2026-09-24T00:00:00Z'),
    updatedAt: new Date('2026-09-24T00:00:00Z'),
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

function makeService() {
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
    mockStreamingSessions as any,
    undefined, // completionTimeout
    mockTranscriptionJobs as any,
  );
}

/** An open STREAMING row, the shape `createForStreamSession` writes. */
function openRow(streamSessionId: string, createdAt: string) {
  return {
    id: `job-${streamSessionId}`,
    jobType: TranscriptionJobType.STREAMING,
    consultationId: CID,
    streamSessionId,
    completedAt: null,
    createdAt: new Date(createdAt),
  };
}

const supersedeEmits = () => mockEventEmitter.emit.mock.calls.filter(([event]) => event === STT_SESSION_SUPERSEDED_EVENT);

function sttStatuses(byId: Record<string, 'active' | 'finalizing' | 'closed' | null | Error>) {
  mockStreamingSessions.getSessionStatus.mockImplementation(async (sessionId: string) => {
    const status = byId[sessionId];
    if (status instanceof Error) throw status;
    return status === null || status === undefined ? null : { sessionId, status };
  });
}

describe('ConsultationService.startRecording — TASK-1003 supersede by the durable binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return TENANT;
      return null;
    });
    mockConsultationRepository.findWithRelations.mockResolvedValue(makeEntity());
    mockConsultationRepository.updateWithVersion.mockImplementation(async (_id: string, entity: ConsultationEntity) => entity);
    mockTranscriptionJobs.findAll.mockResolvedValue([
      openRow('stt-new', '2026-09-24T10:05:00Z'),
      openRow('stt-old', '2026-09-24T10:00:00Z'),
    ]);
    sttStatuses({ 'stt-new': 'active', 'stt-old': 'active' });
  });

  it('announces the older live session exactly once, with the pinned payload, after the RECORDING write', async () => {
    await makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true });

    expect(supersedeEmits()).toEqual([
      [STT_SESSION_SUPERSEDED_EVENT, { tenantId: TENANT, consultationId: CID, supersededSessionId: 'stt-old', supersedingSessionId: 'stt-new' }],
    ]);
    expect(mockTranscriptionJobs.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ consultationId: CID, jobType: TranscriptionJobType.STREAMING, completedAt: null }),
      }),
    );
    const writeOrder = mockConsultationRepository.updateWithVersion.mock.invocationCallOrder[0];
    const emitOrder = mockEventEmitter.emit.mock.invocationCallOrder[mockEventEmitter.emit.mock.calls.findIndex(([e]) => e === STT_SESSION_SUPERSEDED_EVENT)];
    expect(writeOrder).toBeLessThan(emitOrder);
  });

  it('does nothing unless asked — live documentation re-binds (and supersedes) in memory when it holds the session', async () => {
    await makeService().startRecording(CID, { sttSessionId: 'stt-new' });

    expect(mockTranscriptionJobs.findAll).not.toHaveBeenCalled();
    expect(supersedeEmits()).toEqual([]);
  });

  it('a re-sent session id supersedes nothing', async () => {
    mockTranscriptionJobs.findAll.mockResolvedValue([openRow('stt-new', '2026-09-24T10:05:00Z')]);

    await makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true });

    expect(supersedeEmits()).toEqual([]);
  });

  it('skips a row whose session apps/stt no longer reports active — rows can outlive their session', async () => {
    mockTranscriptionJobs.findAll.mockResolvedValue([
      openRow('stt-new', '2026-09-24T10:05:00Z'),
      openRow('stt-finalizing', '2026-09-24T10:03:00Z'),
      openRow('stt-gone', '2026-09-24T10:02:00Z'),
      openRow('stt-live', '2026-09-24T10:01:00Z'),
    ]);
    sttStatuses({ 'stt-new': 'active', 'stt-finalizing': 'finalizing', 'stt-gone': null, 'stt-live': 'active' });

    await makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true });

    expect(supersedeEmits().map(([, payload]) => payload.supersededSessionId)).toEqual(['stt-live']);
  });

  it('never supersedes a NEWER session, so two racing starts cannot supersede each other', async () => {
    mockTranscriptionJobs.findAll.mockResolvedValue([
      openRow('stt-newer', '2026-09-24T10:06:00Z'),
      openRow('stt-new', '2026-09-24T10:05:00Z'),
      openRow('stt-old', '2026-09-24T10:00:00Z'),
    ]);
    sttStatuses({ 'stt-newer': 'active', 'stt-new': 'active', 'stt-old': 'active' });

    await makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true });

    expect(supersedeEmits().map(([, payload]) => payload.supersededSessionId)).toEqual(['stt-old']);
  });

  it('a refused start (409 STT_SESSION_NOT_ACTIVE) supersedes nothing', async () => {
    sttStatuses({ 'stt-new': 'closed', 'stt-old': 'active' });

    await expect(makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true })).rejects.toThrow(ConflictException);

    expect(mockTranscriptionJobs.findAll).not.toHaveBeenCalled();
    expect(supersedeEmits()).toEqual([]);
  });

  it('a failed row read or status lookup never fails the start', async () => {
    mockTranscriptionJobs.findAll.mockRejectedValueOnce(new Error('db down'));
    await expect(makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true })).resolves.toMatchObject({
      status: ConsultationStatus.RECORDING,
    });

    sttStatuses({ 'stt-new': 'active', 'stt-old': new Error('connect ECONNREFUSED') });
    await expect(makeService().startRecording(CID, { sttSessionId: 'stt-new', supersedeByDurableBinding: true })).resolves.toMatchObject({
      status: ConsultationStatus.RECORDING,
    });

    expect(supersedeEmits()).toEqual([]);
  });
});
