import { SSE_METADATA } from '@nestjs/common/constants';
/**
 * The consultation lifecycle on the API: the six commands, the episode reads, the lifecycle event
 * stream, the one-release aliases, the old-vocabulary projection, the admin status filter and the
 * internal segment ingest. Services are stubbed at their tokens; this file pins the controller seam
 * (delegation, idempotent answers passed through, coded 409s passed through, decorator metadata).
 */
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, of, lastValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRES_CONSENT_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';
import { ConsultationLifecycleEventsController } from '../consultation-lifecycle-events.controller';
import { ConsultationLifecycleVocabularyInterceptor, projectLifecycleVocabulary } from '../consultation-lifecycle-vocabulary.interceptor';
import { AdminConsultationController } from '../admin-consultation.controller';
import { SttInternalController } from '../../internal/stt-internal.controller';
import { TENANT_OWNED_RESOURCE_KEY } from '../../../common/tenant-owned-resource.decorator';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';

const ID = '01990000-0000-7000-8000-000000000001';
const DOCTOR = 'doctor-1';
const HEADERS_METADATA = '__headers__';
const REQUIRES_IF_MATCH_KEY = 'requiresIfMatch';

function captureState(status: string, processing = 'IDLE') {
  return {
    consultationId: ID,
    status,
    processing,
    encounterSeq: 1,
    recording: status === 'RECORDING',
    paused: status === 'PAUSED',
    version: 4,
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
}

function consultationRow(status: string, processing = 'IDLE') {
  return { id: ID, doctorId: DOCTOR, patientId: 'patient-1', status, lifecycle: { status, processing }, version: 4 };
}

function buildController(row = consultationRow('OPEN')) {
  const consultationService = {
    getById: vi.fn().mockResolvedValue(row),
    startRecording: vi.fn().mockResolvedValue(consultationRow('RECORDING')),
    stopRecording: vi.fn().mockResolvedValue(consultationRow('STOPPED', 'FINALIZING_TRANSCRIPT')),
    primeConsultation: vi.fn().mockResolvedValue(row),
    closeConsultation: vi.fn().mockResolvedValue(consultationRow('CLOSED_INCOMPLETE')),
    reopenConsultation: vi.fn().mockResolvedValue(consultationRow('OPEN')),
  };
  const lifecycleService = {
    start: vi.fn().mockResolvedValue({ ...captureState('RECORDING'), sessionId: 'stt-1' }),
    pause: vi.fn().mockResolvedValue(captureState('PAUSED')),
    stop: vi.fn().mockResolvedValue({
      ...captureState('STOPPED'),
      finalTranscript: { state: 'complete', contextItemId: 'ft-1', versionNumber: 2, segmentCount: 9, lastSegmentSeq: 9 },
    }),
    approve: vi.fn().mockResolvedValue({
      ...consultationRow('APPROVED'),
      approval: { id: 'ap-1', approvedAt: '2026-10-05T11:00:00.000Z', approvedBy: DOCTOR, snapshotHash: 'h', itemCount: 3 },
    }),
    close: vi.fn(),
    reopen: vi.fn(),
  };
  const encounterService = {
    listForConsultation: vi
      .fn()
      .mockResolvedValue([
        { seq: 1, visitType: 'new-visit', externalRef: null, startedAt: 'a', endedAt: null, recordingStartMs: 0, recordingEndMs: null },
      ]),
  };
  const contextService = { getContextItems: vi.fn().mockResolvedValue([]) };
  const mediaService = { fetchById: vi.fn() };
  const blobStorage = { presignGet: vi.fn() };
  const liveDocumentationService = {
    whenStopped: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(null),
    markHandoffPending: vi.fn().mockResolvedValue(undefined),
  };
  const loopContextSignalService = { signalConsultationEnding: vi.fn().mockResolvedValue(undefined) };
  const summaryService = { approveSummary: vi.fn() };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const cls = new ClsService(new AsyncLocalStorage());

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, {
    consultationService,
    lifecycleService,
    encounterService,
    contextService,
    mediaService,
    blobStorage,
    liveDocumentationService,
    loopContextSignalService,
    summaryService,
    cls,
    logger,
  });

  const inRequest = <T>(fn: () => Promise<T>, principal: 'user' | 'service-account' = 'user'): Promise<T> =>
    cls.run(() => {
      cls.set('tenantId', 'tenant-1');
      if (principal === 'user') cls.set('user', { id: DOCTOR } as never);
      else cls.set('serviceAccount' as never, { id: 'sa-1' } as never);
      return fn();
    });

  return {
    controller,
    consultationService,
    lifecycleService,
    encounterService,
    contextService,
    mediaService,
    blobStorage,
    liveDocumentationService,
    loopContextSignalService,
    summaryService,
    inRequest,
  };
}

const humanReq = { user: { id: DOCTOR } } as never;
const serviceAccountReq = { serviceAccount: { id: 'sa-1' } } as never;
const apiKeyReq = { apiKey: { id: 'key-1', userId: DOCTOR } } as never;

describe('POST :id/start', () => {
  it('checks ownership, waits for a draining stop, starts capture through the lifecycle service and the live session', async () => {
    const t = buildController();
    const result = await t.inRequest(() => t.controller.start(ID, { sessionId: 'stt-1' }));

    expect(t.liveDocumentationService.whenStopped).toHaveBeenCalledWith(ID);
    expect(t.lifecycleService.start).toHaveBeenCalledWith(ID, { sttSessionId: 'stt-1', supersedeByDurableBinding: true });
    expect(t.liveDocumentationService.start).toHaveBeenCalledWith({ consultationId: ID, tenantId: 'tenant-1', userId: DOCTOR, sessionId: 'stt-1' });
    expect(result).toMatchObject({ consultationId: ID, status: 'RECORDING', recording: true, sessionId: 'stt-1' });
  });

  it('passes a coded 409 through untouched and starts no live session', async () => {
    const t = buildController(consultationRow('APPROVED'));
    const refusal = new ConflictException({ code: 'CONSULTATION_NOT_RECORDABLE', message: 'no' });
    t.lifecycleService.start.mockRejectedValueOnce(refusal);

    await expect(t.inRequest(() => t.controller.start(ID, {}))).rejects.toBe(refusal);
    expect(t.liveDocumentationService.start).not.toHaveBeenCalled();
  });

  it('a foreign or unknown consultation is a 404 before the lifecycle service runs', async () => {
    const t = buildController();
    t.consultationService.getById.mockResolvedValueOnce(null);
    await expect(t.inRequest(() => t.controller.start(ID, {}))).rejects.toBeInstanceOf(NotFoundException);
    expect(t.lifecycleService.start).not.toHaveBeenCalled();
  });

  it('carries the consent gate and the session write scope of recording/start', () => {
    const handler = ConsultationController.prototype.start;
    expect(Reflect.getMetadata(REQUIRES_CONSENT_KEY, handler)).toBeDefined();
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:session:write']);
  });
});

describe('POST :id/pause', () => {
  it('delegates as a user pause', async () => {
    const t = buildController(consultationRow('RECORDING'));
    const result = await t.inRequest(() => t.controller.pause(ID));
    expect(t.lifecycleService.pause).toHaveBeenCalledWith(ID, { reason: 'user' });
    expect(result).toMatchObject({ status: 'PAUSED', paused: true });
  });
});

describe('POST :id/stop', () => {
  it('waits for the final transcript by default and drains the live note + signals the loop in the background', async () => {
    const t = buildController(consultationRow('RECORDING'));
    const result = await t.inRequest(() => t.controller.stop(ID, { persistSnapshot: true }));

    expect(t.liveDocumentationService.markHandoffPending).toHaveBeenCalledWith(ID);
    expect(t.lifecycleService.stop).toHaveBeenCalledWith(ID, { waitForFinal: true });
    expect(result.finalTranscript).toEqual({ state: 'complete', contextItemId: 'ft-1', versionNumber: 2, segmentCount: 9, lastSegmentSeq: 9 });
    await vi.waitFor(() =>
      expect(t.loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith(ID, { reason: 'recording_stopped', persistSnapshot: true }),
    );
    expect(t.liveDocumentationService.stop).toHaveBeenCalledWith(ID, { persistSnapshot: true });
  });

  it('honours waitForFinal=false', async () => {
    const t = buildController(consultationRow('RECORDING'));
    await t.inRequest(() => t.controller.stop(ID, { waitForFinal: false }));
    expect(t.lifecycleService.stop).toHaveBeenCalledWith(ID, { waitForFinal: false });
  });

  it('on a STOPPED consultation answers the current finalTranscript state and re-runs nothing (D-28 polling)', async () => {
    const t = buildController(consultationRow('STOPPED', 'FINALIZING_TRANSCRIPT'));
    t.lifecycleService.stop.mockResolvedValueOnce({
      ...captureState('STOPPED', 'FINALIZING_TRANSCRIPT'),
      finalTranscript: { state: 'pending', contextItemId: null, versionNumber: null, segmentCount: 4, lastSegmentSeq: 4 },
    });

    const result = await t.inRequest(() => t.controller.stop(ID, {}));

    expect(result.finalTranscript.state).toBe('pending');
    expect(t.liveDocumentationService.markHandoffPending).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.loopContextSignalService.signalConsultationEnding).not.toHaveBeenCalled();
    expect(t.liveDocumentationService.stop).not.toHaveBeenCalled();
  });
});

describe('POST :id/approve', () => {
  it('approves the whole consultation with the If-Match version and the request caller', async () => {
    const t = buildController(consultationRow('STOPPED'));
    const result = await t.inRequest(() => t.controller.approve(ID, { clinicianUserId: 'doc-2', overrideSafetyFlag: true }, 7, apiKeyReq));

    expect(t.lifecycleService.approve).toHaveBeenCalledWith(ID, {
      expectedVersion: 7,
      clinicianUserId: 'doc-2',
      overrideSafetyFlag: true,
      caller: { isMachine: true, apiKeyId: 'key-1', userId: DOCTOR },
    });
    expect(result).toMatchObject({ status: 'APPROVED' });
  });

  it('maps a service account and a human to the lifecycle caller', async () => {
    const t = buildController(consultationRow('STOPPED'));
    await t.inRequest(() => t.controller.approve(ID, { clinicianUserId: 'doc-2' }, 3, serviceAccountReq), 'service-account');
    expect(t.lifecycleService.approve.mock.calls[0][1].caller).toEqual({ isMachine: true, serviceAccountId: 'sa-1' });

    await t.inRequest(() => t.controller.approve(ID, {}, 3, humanReq));
    expect(t.lifecycleService.approve.mock.calls[1][1].caller).toEqual({ isMachine: false, userId: DOCTOR });
  });

  it('answers the CLOSED_COMPLETE no-op the service returns (D-29)', async () => {
    const t = buildController(consultationRow('CLOSED_COMPLETE'));
    t.lifecycleService.approve.mockResolvedValueOnce(consultationRow('CLOSED_COMPLETE'));
    await expect(t.inRequest(() => t.controller.approve(ID, {}, 9, humanReq))).resolves.toMatchObject({ status: 'CLOSED_COMPLETE' });
  });

  it('passes a processing-in-flight 409 through', async () => {
    const t = buildController(consultationRow('STOPPED', 'SUMMARIZING'));
    const refusal = new ConflictException({ code: 'CONSULTATION_PROCESSING_IN_FLIGHT', message: 'busy' });
    t.lifecycleService.approve.mockRejectedValueOnce(refusal);
    await expect(t.inRequest(() => t.controller.approve(ID, {}, 2, humanReq))).rejects.toBe(refusal);
  });

  it('requires If-Match and the session write scope', () => {
    const handler = ConsultationController.prototype.approve;
    expect(Reflect.getMetadata(REQUIRES_IF_MATCH_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:session:write']);
  });
});

describe('POST :id/close and :id/reopen', () => {
  it('close answers the idempotent closed row the service returns', async () => {
    const t = buildController(consultationRow('CLOSED_COMPLETE'));
    t.consultationService.closeConsultation.mockResolvedValueOnce(consultationRow('CLOSED_COMPLETE'));
    await expect(t.inRequest(() => t.controller.close(ID, 5, undefined, humanReq))).resolves.toMatchObject({ status: 'CLOSED_COMPLETE' });
  });

  it('reopen forwards the reason', async () => {
    const t = buildController(consultationRow('CLOSED_INCOMPLETE'));
    await t.inRequest(() => t.controller.reopen(ID, 6, { reason: 'late result' }));
    expect(t.consultationService.reopenConsultation).toHaveBeenCalledWith(ID, 6, { reason: 'late result' });
  });

  it('reopen without a reason keeps the two-argument call', async () => {
    const t = buildController(consultationRow('CLOSED_INCOMPLETE'));
    await t.inRequest(() => t.controller.reopen(ID, 6, undefined));
    expect(t.consultationService.reopenConsultation).toHaveBeenCalledWith(ID, 6);
  });

  it('reopen passes a REOPEN_NOT_ALLOWED 409 through', async () => {
    const t = buildController(consultationRow('CLOSED_COMPLETE'));
    const refusal = new ConflictException({ code: 'CONSULTATION_REOPEN_NOT_ALLOWED', message: 'policy' });
    t.consultationService.reopenConsultation.mockRejectedValueOnce(refusal);
    await expect(t.inRequest(() => t.controller.reopen(ID, 6, undefined))).rejects.toBe(refusal);
  });
});

describe('GET :id/encounters and :id/recording', () => {
  it('lists the encounters after the read check', async () => {
    const t = buildController();
    const result = await t.inRequest(() => t.controller.listEncounters(ID));
    expect(t.consultationService.getById).toHaveBeenCalledWith(ID);
    expect(t.encounterService.listForConsultation).toHaveBeenCalledWith(ID);
    expect(result).toHaveLength(1);
  });

  it('answers the recording manifest with a presigned URL per part', async () => {
    const t = buildController();
    t.contextService.getContextItems.mockResolvedValueOnce([
      {
        id: 'rec-item',
        currentVersionNumber: 3,
        metadata: {
          manifest: {
            codec: 'opus',
            totalMs: 5000,
            parts: [
              { audioRecordingId: 'ar-1', mediaId: 'm-1', encounterSeq: 1, sttSessionId: 's1', startMs: 0, durationMs: 3000 },
              { audioRecordingId: 'ar-2', mediaId: 'm-2', encounterSeq: 2, sttSessionId: 's2', startMs: 3000, durationMs: 2000 },
            ],
          },
        },
      },
    ]);
    t.mediaService.fetchById.mockImplementation(async (id: string) => ({ id, uri: `s3://hope-audio/${id}.ogg` }));
    t.blobStorage.presignGet.mockImplementation(async ({ key }: { key: string }) => `https://store/${key}?sig`);

    const result = await t.inRequest(() => t.controller.getRecording(ID));

    expect(t.contextService.getContextItems).toHaveBeenCalledWith(ID, { type: 'AUDIO_RECORDING' });
    expect(result).toMatchObject({ contextItemId: 'rec-item', versionNumber: 3, codec: 'opus', totalMs: 5000 });
    expect(result.parts).toEqual([
      expect.objectContaining({ audioRecordingId: 'ar-1', encounterSeq: 1, startMs: 0, durationMs: 3000, url: 'https://store/m-1.ogg?sig' }),
      expect.objectContaining({ audioRecordingId: 'ar-2', encounterSeq: 2, startMs: 3000, durationMs: 2000, url: 'https://store/m-2.ogg?sig' }),
    ]);
    expect(typeof result.parts[0].expiresAt).toBe('string');
  });

  it('is a 404 while the consultation has no recording', async () => {
    const t = buildController();
    await expect(t.inRequest(() => t.controller.getRecording(ID))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('deprecated aliases', () => {
  it.each(['startRecording', 'stopRecording', 'prime', 'approveSummary'] as const)('%s carries Deprecation + Sunset headers', (method) => {
    const headers = (Reflect.getMetadata(HEADERS_METADATA, ConsultationController.prototype[method]) ?? []) as Array<{ name: string }>;
    const names = headers.map((h) => h.name);
    expect(names).toContain('Deprecation');
    expect(names).toContain('Sunset');
  });

  it('prime keeps its consent gate', () => {
    expect(Reflect.getMetadata(REQUIRES_CONSENT_KEY, ConsultationController.prototype.prime)).toBeDefined();
  });

  it('recording/start answers with the real lifecycle pair beside the old shape', async () => {
    const t = buildController();
    const result = await t.inRequest(() => t.controller.startRecording(ID, { sessionId: 'stt-1' }));
    expect(result).toMatchObject({
      consultationId: ID,
      status: 'RECORDING',
      recording: true,
      lifecycle: { status: 'RECORDING', processing: 'IDLE' },
    });
  });

  it('per-summary approve becomes a session approve carrying the summary id and its If-Match', async () => {
    const t = buildController(consultationRow('STOPPED'));
    const result = await t.inRequest(() => t.controller.approveSummary(ID, 'sum-1', { clinicianUserId: 'doc-2' } as never, 11, humanReq));

    expect(t.summaryService.approveSummary).not.toHaveBeenCalled();
    expect(t.lifecycleService.approve).toHaveBeenCalledWith(ID, {
      expectedVersion: 11,
      clinicianUserId: 'doc-2',
      caller: { isMachine: false, userId: DOCTOR },
      legacyContextItemId: 'sum-1',
    });
    expect(result).toEqual({ contextItemId: 'sum-1', approvalStatus: 'APPROVED', approvedBy: DOCTOR, approvedAt: '2026-10-05T11:00:00.000Z' });
  });
});

describe('old-vocabulary projection', () => {
  it('projects status for a client without X-Hope-Lifecycle: 2 and keeps the real pair', () => {
    const body = { data: [consultationRow('STOPPED', 'AWAITING_REVIEW'), consultationRow('PAUSED')], total: 2 };
    const projected = projectLifecycleVocabulary(body) as typeof body;
    expect(projected.data[0]).toMatchObject({ status: 'PENDING_REVIEW', lifecycle: { status: 'STOPPED', processing: 'AWAITING_REVIEW' } });
    expect(projected.data[1]).toMatchObject({ status: 'RECORDING', lifecycle: { status: 'PAUSED' } });
    expect(body.data[0].status).toBe('STOPPED');
  });

  it('adds the lifecycle pair to a capture state before projecting it', () => {
    expect(projectLifecycleVocabulary(captureState('STOPPED', 'SUMMARIZING'))).toMatchObject({
      status: 'DRAFT_PENDING_SENSORS',
      lifecycle: { status: 'STOPPED', processing: 'SUMMARIZING' },
    });
  });

  it('leaves other status fields alone', () => {
    const body = { ...consultationRow('APPROVED'), governingRun: { status: 'RUNNING' } };
    expect(projectLifecycleVocabulary(body)).toMatchObject({ status: 'SIGNED', governingRun: { status: 'RUNNING' } });
    expect(projectLifecycleVocabulary({ jobId: 'j', status: 'pending' })).toEqual({ jobId: 'j', status: 'pending' });
  });

  it('the interceptor projects only without the opt-in header', async () => {
    const interceptor = new ConsultationLifecycleVocabularyInterceptor();
    const context = (headers: Record<string, string>) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({ vary: vi.fn() }) }) }) as never;
    const handler = { handle: () => of(consultationRow('APPROVED')) };

    await expect(lastValueFrom(interceptor.intercept(context({}), handler))).resolves.toMatchObject({ status: 'SIGNED' });
    await expect(lastValueFrom(interceptor.intercept(context({ 'x-hope-lifecycle': '2' }), handler))).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('the interceptor leaves @Sse() handlers alone (their frames are not consultation bodies)', async () => {
    const interceptor = new ConsultationLifecycleVocabularyInterceptor();
    const sseHandler = () => undefined;
    Reflect.defineMetadata(SSE_METADATA, true, sseHandler);
    const vary = vi.fn();
    const frame = { data: { status: 'APPROVED', consultationId: 'c-1' } };
    const context = {
      getHandler: () => sseHandler,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => ({ vary }) }),
    } as never;

    await expect(lastValueFrom(interceptor.intercept(context, { handle: () => of(frame) }))).resolves.toBe(frame);
    expect(vary).not.toHaveBeenCalled();
  });
});

describe('GET :id/events', () => {
  function events() {
    const publisher = { subscribe: vi.fn().mockReturnValue(of({ data: '{"seq":3}' })) };
    const controller = new ConsultationLifecycleEventsController(publisher as never);
    return { controller, publisher };
  }

  it('subscribes from `since`', async () => {
    const { controller, publisher } = events();
    await firstValueFrom(controller.streamEvents(ID, '2'));
    expect(publisher.subscribe).toHaveBeenCalledWith(ID, 2);
  });

  it('subscribes from the start without `since`, and refuses a malformed one', () => {
    const { controller, publisher } = events();
    controller.streamEvents(ID, undefined);
    expect(publisher.subscribe).toHaveBeenCalledWith(ID, undefined);
    expect(() => controller.streamEvents(ID, '-1')).toThrow(BadRequestException);
    expect(() => controller.streamEvents(ID, 'abc')).toThrow(BadRequestException);
  });

  it('is guarded like the live-summary stream', () => {
    const handler = ConsultationLifecycleEventsController.prototype.streamEvents;
    expect(Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, handler)).toEqual({ modelName: 'Consultation', paramName: 'id' });
    expect(Reflect.getMetadata(STREAM_SCOPE_METADATA, handler)).toEqual({ namespace: 'consultation_lifecycle', param: 'id' });
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:session:write']);
  });
});

describe('admin list filter', () => {
  function admin() {
    const consultationService = { listConsultationsForTenant: vi.fn().mockResolvedValue({ data: [] }) };
    return { controller: new AdminConsultationController(consultationService as never), consultationService };
  }

  it('accepts the seven statuses and a processing value', async () => {
    const { controller, consultationService } = admin();
    await controller.list({ status: 'PAUSED', processing: 'AWAITING_REVIEW' } as never);
    expect(consultationService.listConsultationsForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PAUSED', processing: 'AWAITING_REVIEW' }),
    );
  });

  it('refuses an old-vocabulary status and an unknown processing value', async () => {
    const { controller } = admin();
    await expect(controller.list({ status: 'DRAINING' } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list({ processing: 'BUSY' } as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('POST internal/stt/segments', () => {
  function internal(secret = 'gw-secret') {
    const transcriptRecord = { ingestSegments: vi.fn().mockResolvedValue({ accepted: 2, duplicates: 0, lastSegmentSeq: 7 }) };
    const secretsService = { getSecretOptional: vi.fn().mockResolvedValue(secret) };
    const cls = new ClsService(new AsyncLocalStorage());
    const controller: SttInternalController = Object.create(SttInternalController.prototype);
    Object.assign(controller as unknown as Record<string, unknown>, { transcriptRecord, secretsService, cls });
    return { controller, transcriptRecord, cls };
  }
  const body = (segments: unknown[] = [{ utteranceIndex: 0, text: 'hi', startMs: 0, endMs: 900, capturedAt: '2026-10-05T10:00:00Z' }]) => ({
    tenantId: 'tenant-9',
    consultationId: ID,
    sttSessionId: 'stt-1',
    audioOffsetMs: 1200,
    segments,
  });
  const workerReq = { apiKey: { id: 'worker' }, headers: { 'x-internal-service-key': 'gw-secret' } } as never;

  it('ingests under the addressed tenant', async () => {
    const { controller, transcriptRecord, cls } = internal();
    let tenantSeen: unknown;
    transcriptRecord.ingestSegments.mockImplementationOnce(async () => {
      tenantSeen = cls.get('tenantId');
      return { accepted: 1, duplicates: 0, lastSegmentSeq: 1 };
    });

    const result = await controller.ingestSegments(workerReq, body() as never, 'tenant-9');

    expect(transcriptRecord.ingestSegments).toHaveBeenCalledWith(body());
    expect(tenantSeen).toBe('tenant-9');
    expect(result).toEqual({ accepted: 1, duplicates: 0, lastSegmentSeq: 1 });
  });

  it('passes an empty batch through as a heartbeat', async () => {
    const { controller, transcriptRecord } = internal();
    await controller.ingestSegments(workerReq, body([]) as never, 'tenant-9');
    expect(transcriptRecord.ingestSegments).toHaveBeenCalledWith(expect.objectContaining({ segments: [] }));
  });

  it('requires the API-key worker, the tenant header, a matching body tenant and the platform credential', async () => {
    const { controller, transcriptRecord } = internal();
    await expect(controller.ingestSegments({ headers: {} } as never, body() as never, 'tenant-9')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.ingestSegments(workerReq, body() as never, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.ingestSegments(workerReq, body() as never, 'tenant-other')).rejects.toBeInstanceOf(BadRequestException);
    const wrongKey = { apiKey: { id: 'worker' }, headers: { 'x-internal-service-key': 'nope' } } as never;
    await expect(controller.ingestSegments(wrongKey, body() as never, 'tenant-9')).rejects.toBeInstanceOf(ForbiddenException);
    expect(transcriptRecord.ingestSegments).not.toHaveBeenCalled();
  });
});
