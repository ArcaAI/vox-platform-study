/**
 * TASK-1045 lane AB-4a — the consultation lifecycle commands (start / pause / stop / close /
 * reopen), the content-lock + processing gate, the lifecycle event publisher and the legacy
 * status projection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  ConsultationClosedReason,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { ConsultationPipelineEvent } from '../../events/consultation.events';
import { ConsultationLifecycleService } from '../consultation-lifecycle.service';
import { ConsultationLifecycleGate } from '../consultation-lifecycle.gate';
import { ConsultationLifecycleEventPublisher, LIFECYCLE_REPLAY_SIZE, lifecycleChannel } from '../lifecycle-event.publisher';
import { projectLegacyConsultationStatus } from '../legacy-status-projection';
import { DocumentSectionService } from '../../document-section/document-section.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ID = 'c-1';
const DOCTOR = 'doctor-1';

type Row = ConstructorParameters<typeof ConsultationEntity>[0];

function consultation(overrides: Partial<Row> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: ID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: DOCTOR,
    departmentId: null,
    appointmentDate: new Date('2026-10-05'),
    status: ConsultationStatus.OPEN,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: 1,
    segmentSeqHead: 0,
    version: 3,
    createdAt: new Date('2026-10-05T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
    ...overrides,
  } as Row);
}

/** What `updateWithVersion` hands back: the row as persisted, `_version` bumped by the database. */
function persisted(entity: ConsultationEntity): ConsultationEntity {
  const row = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity) as ConsultationEntity;
  Object.assign(row, { _version: entity.version + 1, _changes: {} });
  return row;
}

function cls(tenantId: string | null = TENANT) {
  return {
    get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)),
    set: vi.fn(),
    getId: vi.fn(() => 'req-1'),
  };
}

function makeHarness(row: ConsultationEntity | null, opts: { tenantId?: string | null; settings?: Record<string, unknown> } = {}) {
  let current = row;
  const consultations = {
    findByIdOrNull: vi.fn(async () => current),
    findWithRelations: vi.fn(async () => current),
    updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity, expected: number) => {
      if (expected !== entity.version) {
        throw new OptimisticConcurrencyException('Consultation', ID, { expectedVersion: expected, currentVersion: entity.version });
      }
      current = persisted(entity);
      return current;
    }),
    setProcessing: vi.fn(async () => true),
    touchActivity: vi.fn(async () => true),
  };
  const encounters = { endEncounter: vi.fn(async () => true) };
  const transcriptionJobs = {
    findAll: vi.fn(async () => [
      { streamSessionId: 'stt-a', createdAt: new Date('2026-10-05T08:01:00Z') },
      { streamSessionId: 'stt-dead', createdAt: new Date('2026-10-05T08:00:30Z') },
    ]),
  };
  const streamingSessions = {
    getSessionStatus: vi.fn(async (sessionId: string) => ({ status: sessionId === 'stt-dead' ? 'closed' : 'active' })),
  };
  const bridge = { writeControlCommand: vi.fn(async () => undefined) };
  const transcriptRecord = { awaitFinal: vi.fn(async () => 'complete' as const) };
  const contextItems = {
    findFullTranscript: vi.fn(async () => ({ id: 'ft-1', currentVersionNumber: 4, metaData: { segmentCount: 12 } })),
  };
  const settings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (opts.settings && key in opts.settings) return { key, value: opts.settings[key] };
      throw new Error(`unknown setting ${key}`);
    }),
  };
  const cache = {
    incr: vi.fn(async () => 7),
    eval: vi.fn(async () => 1),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = cls(opts.tenantId === undefined ? TENANT : opts.tenantId);

  const publisher = new ConsultationLifecycleEventPublisher(eventEmitter as never, clsService as never, cache as never, undefined);
  const gate = new ConsultationLifecycleGate(consultations as never, publisher, clsService as never);
  const approval = { approve: vi.fn() };
  const service = new ConsultationLifecycleService(
    consultations as never,
    encounters as never,
    contextItems as never,
    approval as never,
    gate,
    publisher,
    eventEmitter as never,
    clsService as never,
    transcriptionJobs as never,
    streamingSessions as never,
    bridge as never,
    transcriptRecord as never,
    settings as never,
  );

  const lifecycleEvents = () =>
    eventEmitter.emit.mock.calls
      .filter(([name]) => name === ConsultationPipelineEvent.LifecycleChanged)
      .map(([, payload]) => (payload as { event: { type: string } }).event);
  const sysEvents = () => eventEmitter.emit.mock.calls.filter(([name]) => name === SysEventType.ResourceUpdated).map(([, payload]) => payload);

  return {
    service,
    gate,
    publisher,
    consultations,
    encounters,
    transcriptionJobs,
    streamingSessions,
    bridge,
    transcriptRecord,
    contextItems,
    settings,
    cache,
    eventEmitter,
    approval,
    lifecycleEvents,
    sysEvents,
    current: () => current,
  };
}

function conflictCode(error: unknown): unknown {
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { code?: string }).code;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('ConsultationLifecycleService — start', () => {
  it('OPEN → RECORDING: persists through updateWithVersion, returns CaptureState, and emits started', async () => {
    const h = makeHarness(consultation());
    const state = await h.service.start(ID, { sttSessionId: 'stt-a' });

    expect(h.consultations.updateWithVersion).toHaveBeenCalledWith(ID, expect.any(ConsultationEntity), 3);
    expect(state).toMatchObject({
      consultationId: ID,
      status: 'RECORDING',
      processing: 'IDLE',
      encounterSeq: 1,
      sessionId: 'stt-a',
      recording: true,
      paused: false,
      version: 4,
    });
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['started']);
    expect(h.consultations.touchActivity).toHaveBeenCalledWith(ID);
  });

  it('broadcasts ResourceUpdated with data.action = lifecycle and publishes the frame on consultation:lifecycle:{id}', async () => {
    const h = makeHarness(consultation());
    await h.service.start(ID);

    const sys = h.sysEvents();
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({
      resourceId: ID,
      resourceType: ResourceType.Consultation,
      tenantId: TENANT,
      data: { action: 'lifecycle', event: 'started', status: 'RECORDING', processing: 'IDLE', version: 4, seq: 7 },
    });

    // One atomic script appends to the replay buffer, trims it to the contract size and publishes.
    const [script, numKeys, ...args] = h.cache.eval.mock.calls[0];
    expect(script).toContain('PUBLISH');
    expect(script).toContain('LTRIM');
    expect(numKeys).toBe(2);
    expect(args).toContain(lifecycleChannel(ID));
    expect(args).toContain(-LIFECYCLE_REPLAY_SIZE);
    const frame = JSON.parse(String(args.find((a) => typeof a === 'string' && a.startsWith('{'))));
    expect(frame).toMatchObject({ type: 'started', consultationId: ID, status: 'RECORDING', version: 4, seq: 7 });
  });

  it('refuses a closed consultation with 409 CONSULTATION_NOT_RECORDABLE and writes nothing', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.CLOSED_COMPLETE }));
    expect(conflictCode(await rejectionOf(h.service.start(ID)))).toBe('CONSULTATION_NOT_RECORDABLE');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  it('refuses an STT session apps/stt reports as not active (409 STT_SESSION_NOT_ACTIVE)', async () => {
    const h = makeHarness(consultation());
    expect(conflictCode(await rejectionOf(h.service.start(ID, { sttSessionId: 'stt-dead' })))).toBe('STT_SESSION_NOT_ACTIVE');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  it('PAUSED → RECORDING sends the resume control to the live bound sessions', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.PAUSED }));
    await h.service.start(ID);
    expect(h.bridge.writeControlCommand).toHaveBeenCalledWith('stt-a', 'resume');
    expect(h.bridge.writeControlCommand).not.toHaveBeenCalledWith('stt-dead', expect.anything());
  });

  it('is a no-op on RECORDING (no write, no event)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING }));
    const state = await h.service.start(ID);
    expect(state.status).toBe('RECORDING');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([]);
  });

  it('answers 404 for a consultation of another tenant', async () => {
    const h = makeHarness(consultation({ tenantId: OTHER_TENANT }));
    expect(await rejectionOf(h.service.start(ID))).toBeInstanceOf(NotFoundException);
  });
});

describe('ConsultationLifecycleService — pause', () => {
  it('RECORDING → PAUSED, sends the pause control, emits paused', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING }));
    const state = await h.service.pause(ID, { reason: 'user' });
    expect(state).toMatchObject({ status: 'PAUSED', recording: false, paused: true });
    expect(h.bridge.writeControlCommand).toHaveBeenCalledWith('stt-a', 'pause');
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['paused']);
  });

  it('is idempotent on PAUSED', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.PAUSED }));
    await h.service.pause(ID);
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  it('refuses OPEN → PAUSED with 409 CONSULTATION_TRANSITION_ILLEGAL', async () => {
    const h = makeHarness(consultation());
    expect(conflictCode(await rejectionOf(h.service.pause(ID)))).toBe('CONSULTATION_TRANSITION_ILLEGAL');
  });
});

describe('ConsultationLifecycleService — stop', () => {
  it('RECORDING → STOPPED + FINALIZING_TRANSCRIPT, finalizes the live sessions, awaits the final transcript, then emits EncounterStopped + transcript_final', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 2, segmentSeqHead: 12 }), {
      settings: { 'consultation.stop.finalTranscriptTimeoutSeconds': 20 },
    });
    const result = await h.service.stop(ID);

    const written = h.consultations.updateWithVersion.mock.calls[0][1] as ConsultationEntity;
    expect(written.status).toBe(ConsultationStatus.STOPPED);
    expect(written.processing).toBe(ConsultationProcessing.FINALIZING_TRANSCRIPT);
    expect(h.bridge.writeControlCommand).toHaveBeenCalledWith('stt-a', 'finalize');
    expect(h.bridge.writeControlCommand).toHaveBeenCalledTimes(1);
    expect(h.transcriptRecord.awaitFinal).toHaveBeenCalledWith(ID, ['stt-a'], 20_000);

    // processing goes back WITHOUT a `_version` bump
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.IDLE, expect.objectContaining({ prior: null }));
    expect(h.consultations.updateWithVersion).toHaveBeenCalledTimes(1);

    const encounterStopped = h.eventEmitter.emit.mock.calls.find(([name]) => name === ConsultationPipelineEvent.EncounterStopped);
    expect(encounterStopped?.[1]).toMatchObject({ consultationId: ID, tenantId: TENANT, encounterSeq: 2 });
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['stopped', 'transcript_final']);

    expect(result).toMatchObject({
      status: 'STOPPED',
      processing: 'IDLE',
      encounterSeq: 2,
      finalTranscript: { state: 'complete', contextItemId: 'ft-1', versionNumber: 4, segmentCount: 12, lastSegmentSeq: 12 },
    });
  });

  it('returns pending on the await timeout, leaves processing FINALIZING_TRANSCRIPT and emits no EncounterStopped', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.PAUSED }));
    h.transcriptRecord.awaitFinal.mockResolvedValueOnce('pending');
    const result = await h.service.stop(ID);

    expect(result.finalTranscript.state).toBe('pending');
    expect(result.processing).toBe('FINALIZING_TRANSCRIPT');
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(h.eventEmitter.emit.mock.calls.some(([name]) => name === ConsultationPipelineEvent.EncounterStopped)).toBe(false);
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['stopped']);
  });

  it('waitForFinal=false never waits and answers pending', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING }));
    const result = await h.service.stop(ID, { waitForFinal: false });
    expect(h.transcriptRecord.awaitFinal).not.toHaveBeenCalled();
    expect(result.finalTranscript.state).toBe('pending');
  });

  it('is idempotent on STOPPED (D-28): no write, no control, the current final-transcript state', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.FINALIZING_TRANSCRIPT }));
    const pending = await h.service.stop(ID);
    expect(pending.finalTranscript.state).toBe('pending');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    expect(h.bridge.writeControlCommand).not.toHaveBeenCalled();

    const h2 = makeHarness(consultation({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.SUMMARIZING }));
    expect((await h2.service.stop(ID)).finalTranscript.state).toBe('complete');
  });

  it('refuses OPEN → STOPPED with 409 CONSULTATION_TRANSITION_ILLEGAL', async () => {
    const h = makeHarness(consultation());
    expect(conflictCode(await rejectionOf(h.service.stop(ID)))).toBe('CONSULTATION_TRANSITION_ILLEGAL');
  });
});

describe('ConsultationLifecycleService — close', () => {
  it('STOPPED → CLOSED_INCOMPLETE (MANUAL), ends the current encounter, emits closed', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }));
    const response = await h.service.close(ID, { expectedVersion: 3 });
    expect(response.status).toBe('CLOSED_INCOMPLETE');
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.MANUAL);
    expect(h.encounters.endEncounter).toHaveBeenCalledWith(ID, 1, expect.any(Object));
    expect(h.lifecycleEvents()).toEqual([expect.objectContaining({ type: 'closed', closedReason: 'MANUAL' })]);
  });

  it('APPROVED → CLOSED_COMPLETE with closedReason APPROVED (D-29)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.APPROVED }));
    const response = await h.service.close(ID);
    expect(response.status).toBe('CLOSED_COMPLETE');
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.APPROVED);
  });

  it('an auto close stamps closedReason AUTO', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN }));
    await h.service.close(ID, { auto: true });
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.AUTO);
  });

  it('RECORDING is flushed first (finalize control) and then closed', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING }));
    await h.service.close(ID);
    expect(h.bridge.writeControlCommand).toHaveBeenCalledWith('stt-a', 'finalize');
    expect(h.current()?.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
  });

  it('is idempotent on a closed consultation (D-29): no write, no event', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.CLOSED_COMPLETE }));
    const response = await h.service.close(ID, { expectedVersion: 99 });
    expect(response.status).toBe('CLOSED_COMPLETE');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([]);
  });

  it('a stale If-Match surfaces the optimistic-concurrency failure (412)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }));
    expect(await rejectionOf(h.service.close(ID, { expectedVersion: 2 }))).toBeInstanceOf(OptimisticConcurrencyException);
  });
});

describe('ConsultationLifecycleService — reopen', () => {
  it('CLOSED_INCOMPLETE → OPEN always; reopenCount++, approvedAt cleared, emits reopened', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.CLOSED_INCOMPLETE, closedReason: ConsultationClosedReason.AUTO, closedAt: new Date() }));
    const response = await h.service.reopen(ID, { expectedVersion: 3 });
    expect(response.status).toBe('OPEN');
    expect(h.current()?.reopenCount).toBe(1);
    expect(h.current()?.closedReason).toBeNull();
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['reopened']);
  });

  it('CLOSED_COMPLETE is refused unless consultation.reopen.allowClosedComplete (409 CONSULTATION_REOPEN_NOT_ALLOWED)', async () => {
    const refused = makeHarness(consultation({ status: ConsultationStatus.CLOSED_COMPLETE, approvedAt: new Date() }), {
      settings: { 'consultation.reopen.allowClosedComplete': false },
    });
    expect(conflictCode(await rejectionOf(refused.service.reopen(ID, { expectedVersion: 3 })))).toBe('CONSULTATION_REOPEN_NOT_ALLOWED');

    const allowed = makeHarness(consultation({ status: ConsultationStatus.CLOSED_COMPLETE, approvedAt: new Date() }), {
      settings: { 'consultation.reopen.allowClosedComplete': true },
    });
    await allowed.service.reopen(ID, { expectedVersion: 3 });
    expect(allowed.settings.resolveEffective).toHaveBeenCalledWith('consultation.reopen.allowClosedComplete', expect.objectContaining({ tenantId: TENANT }));
    expect(allowed.current()?.status).toBe(ConsultationStatus.OPEN);
    expect(allowed.current()?.approvedAt).toBeNull();
  });

  it('an unresolvable policy denies (fail-safe)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.CLOSED_COMPLETE }));
    expect(conflictCode(await rejectionOf(h.service.reopen(ID, { expectedVersion: 3 })))).toBe('CONSULTATION_REOPEN_NOT_ALLOWED');
  });

  it('refuses a reopen of a consultation that is not closed', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }));
    expect(conflictCode(await rejectionOf(h.service.reopen(ID, { expectedVersion: 3 })))).toBe('CONSULTATION_TRANSITION_ILLEGAL');
  });
});

describe('ConsultationLifecycleService — approve delegates to the approval service', () => {
  it('passes the options through', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }));
    h.approval.approve.mockResolvedValue({ id: ID, status: 'APPROVED' });
    const caller = { userId: DOCTOR, isMachine: false };
    await h.service.approve(ID, { expectedVersion: 3, caller });
    expect(h.approval.approve).toHaveBeenCalledWith(ID, { expectedVersion: 3, caller });
  });
});

describe('ConsultationLifecycleGate', () => {
  it('assertContentWritable: APPROVED / CLOSED_COMPLETE → 409 CONSULTATION_APPROVED, CLOSED_INCOMPLETE → 409 CONSULTATION_CLOSED', async () => {
    for (const [status, code] of [
      [ConsultationStatus.APPROVED, 'CONSULTATION_APPROVED'],
      [ConsultationStatus.CLOSED_COMPLETE, 'CONSULTATION_APPROVED'],
      [ConsultationStatus.CLOSED_INCOMPLETE, 'CONSULTATION_CLOSED'],
    ] as const) {
      const h = makeHarness(consultation({ status }));
      expect(conflictCode(await rejectionOf(h.gate.assertContentWritable(ID)))).toBe(code);
    }
    for (const status of [ConsultationStatus.OPEN, ConsultationStatus.RECORDING, ConsultationStatus.PAUSED, ConsultationStatus.STOPPED]) {
      await expect(makeHarness(consultation({ status })).gate.assertContentWritable(ID)).resolves.toBeUndefined();
    }
  });

  it('assertContentWritable answers 404 for a missing or foreign consultation', async () => {
    expect(await rejectionOf(makeHarness(null).gate.assertContentWritable(ID))).toBeInstanceOf(NotFoundException);
    expect(await rejectionOf(makeHarness(consultation({ tenantId: OTHER_TENANT })).gate.assertContentWritable(ID))).toBeInstanceOf(
      NotFoundException,
    );
  });

  it('beginProcessing records the ref and the prior marker without a version bump, and emits processing_changed', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.AWAITING_REVIEW }));
    await h.gate.beginProcessing(ID, ConsultationProcessing.PROCESSING_ATTACHMENT, 'att-1');
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.PROCESSING_ATTACHMENT, {
      refs: ['att-1'],
      prior: ConsultationProcessing.AWAITING_REVIEW,
    });
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([expect.objectContaining({ type: 'processing_changed', processing: 'PROCESSING_ATTACHMENT', version: 3 })]);
  });

  it('endProcessing restores the prior marker once the last ref ends, and keeps it while refs remain', async () => {
    const busy = makeHarness(
      consultation({
        processing: ConsultationProcessing.PROCESSING_ATTACHMENT,
        processingRefs: ['att-1', 'att-2'],
        processingPrior: ConsultationProcessing.IDLE,
      }),
    );
    await busy.gate.endProcessing(ID, 'att-1');
    expect(busy.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.PROCESSING_ATTACHMENT, { refs: ['att-2'] });
    expect(busy.lifecycleEvents()).toEqual([]);

    const last = makeHarness(
      consultation({
        processing: ConsultationProcessing.PROCESSING_ATTACHMENT,
        processingRefs: ['att-2'],
        processingPrior: ConsultationProcessing.AWAITING_REVIEW,
      }),
    );
    await last.gate.endProcessing(ID, 'att-2');
    expect(last.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.AWAITING_REVIEW, { refs: [], prior: null });
    expect(last.lifecycleEvents().map((e) => e.type)).toEqual(['processing_changed']);
  });

  it('endProcessing with failed marks FAILED with the reason', async () => {
    const h = makeHarness(consultation({ processing: ConsultationProcessing.PROCESSING_ATTACHMENT, processingRefs: ['att-1'] }));
    await h.gate.endProcessing(ID, 'att-1', { failed: true, reason: 'OCR_FAILED' });
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.FAILED, { reason: 'OCR_FAILED', refs: [], prior: null });
  });

  it('setProcessing writes through the no-version-bump writer and emits only on change', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }));
    await h.gate.setProcessing(ID, ConsultationProcessing.SUMMARIZING);
    await h.gate.setProcessing(ID, ConsultationProcessing.IDLE);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.SUMMARIZING, { reason: null });
    expect(h.lifecycleEvents().map((e) => e.processing)).toEqual(['SUMMARIZING']);
  });

  it('touchActivity and currentEncounterSeq', async () => {
    const h = makeHarness(consultation({ currentEncounterSeq: 3 }));
    await h.gate.touchActivity(ID);
    expect(h.consultations.touchActivity).toHaveBeenCalledWith(ID);
    expect(await h.gate.currentEncounterSeq(ID)).toBe(3);
  });
});

describe('ConsultationLifecycleEventPublisher — replay', () => {
  it('returns the buffered frames newer than `since`, in seq order', async () => {
    const h = makeHarness(consultation());
    const frames = [5, 3, 4].map((seq) => JSON.stringify({ type: 'started', consultationId: ID, seq }));
    h.cache.eval.mockResolvedValueOnce(frames);
    const replayed = await h.publisher.replay(ID, 3);
    expect(replayed.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('a Redis failure never fails the lifecycle command', async () => {
    const h = makeHarness(consultation());
    h.cache.incr.mockRejectedValue(new Error('redis down'));
    h.cache.eval.mockRejectedValue(new Error('redis down'));
    await expect(h.service.start(ID)).resolves.toMatchObject({ status: 'RECORDING' });
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['started']);
  });
});

describe('projectLegacyConsultationStatus (ALaaS 4.1 window)', () => {
  it.each([
    ['OPEN', 'IDLE', 'OPEN'],
    ['RECORDING', 'IDLE', 'RECORDING'],
    ['PAUSED', 'IDLE', 'RECORDING'],
    ['STOPPED', 'FINALIZING_TRANSCRIPT', 'DRAINING'],
    ['STOPPED', 'IDLE', 'DRAINING'],
    ['STOPPED', 'SUMMARIZING', 'DRAFT_PENDING_SENSORS'],
    ['STOPPED', 'AWAITING_REVIEW', 'PENDING_REVIEW'],
    ['STOPPED', 'FAILED', 'PENDING_REVIEW'],
    ['APPROVED', 'IDLE', 'SIGNED'],
    ['CLOSED_COMPLETE', 'IDLE', 'CLOSED_COMPLETE'],
    ['CLOSED_INCOMPLETE', 'IDLE', 'CLOSED_INCOMPLETE'],
  ] as const)('%s + %s → %s', (status, processing, legacy) => {
    expect(projectLegacyConsultationStatus(status, processing)).toBe(legacy);
  });
});

describe('DocumentSectionService — content lock', () => {
  let repo: { findSection: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    repo = {
      findSection: vi.fn(async () => ({ id: 's-1', consultationId: ID, version: 2, isWritable: () => true, title: 'Plan', idx: 0 })),
    };
  });

  it('answers the lifecycle 409 before the section state or the compare-and-set', async () => {
    const gate = { assertContentWritable: vi.fn(async () => Promise.reject(new ConflictException({ code: 'CONSULTATION_APPROVED' }))) };
    const service = new DocumentSectionService(repo as never, { emit: vi.fn() } as never, cls() as never, undefined, gate as never);
    const error = await rejectionOf(service.updateSectionContent(ID, 'soap', 'plan', { content: 'x', expectedVersion: 1 } as never));
    expect(conflictCode(error)).toBe('CONSULTATION_APPROVED');
    expect(gate.assertContentWritable).toHaveBeenCalledWith(ID);
  });

  it('a missing section is still a 404 first (existence before the rule)', async () => {
    repo.findSection.mockResolvedValueOnce(null);
    const gate = { assertContentWritable: vi.fn() };
    const service = new DocumentSectionService(repo as never, { emit: vi.fn() } as never, cls() as never, undefined, gate as never);
    expect(await rejectionOf(service.updateSectionContent(ID, 'soap', 'plan', { content: 'x', expectedVersion: 1 } as never))).toBeInstanceOf(
      NotFoundException,
    );
    expect(gate.assertContentWritable).not.toHaveBeenCalled();
  });
});
