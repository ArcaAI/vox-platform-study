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
  HarnessAuditAction,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { ConsultationPipelineEvent } from '../../events/consultation.events';
import { ConsultationLifecycleService } from '../consultation-lifecycle.service';
import { ConsultationLifecycleGate } from '../consultation-lifecycle.gate';
import { ConsultationLifecycleEventPublisher, LIFECYCLE_REPLAY_SIZE, lifecycleChannel } from '../lifecycle-event.publisher';
import { NOTE_READY_REASON, projectLegacyConsultationStatus } from '../legacy-status-projection';
import { DocumentSectionService } from '../../document-section/document-section.service';
import { encounterStoppedRedisKey } from '../../transcript-record/transcript-record.keys';

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

function cls(tenantId: string | null = TENANT, user: { id: string; roles: string[] } | null = { id: DOCTOR, roles: [] }) {
  return {
    get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : key === 'user' ? (user ?? undefined) : undefined)),
    set: vi.fn(),
    getId: vi.fn(() => 'req-1'),
  };
}

function makeHarness(
  row: ConsultationEntity | null,
  opts: { tenantId?: string | null; settings?: Record<string, unknown>; user?: { id: string; roles: string[] } | null } = {},
) {
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
  const openEncounter = { id: 'enc-1', endedAt: new Date('2026-10-05T08:30:00Z'), recordingEndMs: 4000 } as Record<string, unknown>;
  const encounters = {
    endEncounter: vi.fn(async () => true),
    findBySeq: vi.fn(async () => openEncounter),
    update: vi.fn(async (_id: string, e: unknown) => e),
  };
  const encounterService = {
    lifecycleView: vi.fn(async () => ({ encounters: [], approval: null, autoCloseAt: null, allowClosedCompleteReopen: false })),
  };
  const transcriptionJobs = {
    findAll: vi.fn(async () => [
      { streamSessionId: 'stt-a', createdAt: new Date('2026-10-05T08:01:00Z') },
      { streamSessionId: 'stt-dead', createdAt: new Date('2026-10-05T08:00:30Z') },
    ]),
    update: vi.fn(async (_id: string, job: unknown) => job),
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
  // The SET NX marker store `stop` claims before announcing the encounter (shared with the
  // transcript record's session-final path).
  const markers = { eval: vi.fn(async () => 'OK' as string | null) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = cls(opts.tenantId === undefined ? TENANT : opts.tenantId, opts.user === undefined ? { id: DOCTOR, roles: [] } : opts.user);
  // The SESSION_CLOSED_* WORM trail.
  const harnessAudit = { append: vi.fn(async () => ({ id: 'audit-1' })) };

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
    encounterService as never,
    markers as never,
    harnessAudit as never,
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
    encounterService,
    openEncounter,
    transcriptionJobs,
    streamingSessions,
    bridge,
    transcriptRecord,
    contextItems,
    settings,
    cache,
    markers,
    harnessAudit,
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

  it('STOPPED → RECORDING continues the current encounter: its endedAt / recordingEndMs are cleared', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, currentEncounterSeq: 2 }));
    await h.service.start(ID);
    expect(h.encounters.findBySeq).toHaveBeenCalledWith(ID, 2);
    expect(h.encounters.update).toHaveBeenCalledWith('enc-1', expect.objectContaining({ endedAt: null, recordingEndMs: null }));
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

  it('stamps the bound session job with recordingOffsetMs = the recording cursor when it has none', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, recordingCursorMs: 61_500 } as Partial<Row>));
    const job = { id: 'job-a', streamSessionId: 'stt-a', metaData: { agentSlug: 'asr' } as Record<string, unknown> };
    h.transcriptionJobs.findAll.mockImplementation(async (query?: { filters?: { streamSessionId?: string } }) =>
      query?.filters?.streamSessionId === 'stt-a' ? [job] : [{ streamSessionId: 'stt-a', createdAt: new Date('2026-10-05T08:01:00Z') }],
    );

    await h.service.start(ID, { sttSessionId: 'stt-a' });

    expect(h.transcriptionJobs.update).toHaveBeenCalledTimes(1);
    expect(h.transcriptionJobs.update).toHaveBeenCalledWith('job-a', expect.objectContaining({ metaData: { agentSlug: 'asr', recordingOffsetMs: 61_500 } }));
  });

  it('stamps the current encounter with the recording cursor as its recording start when it has none', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN, recordingCursorMs: 61_500 } as Partial<Row>));
    h.encounters.findBySeq.mockResolvedValueOnce({ id: 'enc-2', endedAt: null, recordingStartMs: null, recordingEndMs: null } as never);

    await h.service.start(ID, { sttSessionId: 'stt-a' });

    expect(h.encounters.update).toHaveBeenCalledWith('enc-2', expect.objectContaining({ recordingStartMs: 61_500 }));
  });

  it('never overwrites a recordingOffsetMs the session job already carries', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, recordingCursorMs: 61_500 } as Partial<Row>));
    const job = { id: 'job-a', streamSessionId: 'stt-a', metaData: { recordingOffsetMs: 12_000 } };
    h.transcriptionJobs.findAll.mockImplementation(async (query?: { filters?: { streamSessionId?: string } }) =>
      query?.filters?.streamSessionId === 'stt-a' ? [job] : [],
    );

    await h.service.start(ID, { sttSessionId: 'stt-a' });

    expect(h.transcriptionJobs.update).not.toHaveBeenCalled();
  });

  it('a failed offset stamp never fails the start', async () => {
    const h = makeHarness(consultation());
    h.transcriptionJobs.findAll.mockImplementation(async (query?: { filters?: { streamSessionId?: string } }) =>
      query?.filters?.streamSessionId === 'stt-a' ? [{ id: 'job-a', streamSessionId: 'stt-a', metaData: null }] : [],
    );
    h.transcriptionJobs.update.mockRejectedValueOnce(new Error('db down'));

    const state = await h.service.start(ID, { sttSessionId: 'stt-a' });
    expect(state.status).toBe('RECORDING');
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
    // the encounter's speech ended: a later re-visit open appends encounter 3
    expect(h.encounters.endEncounter).toHaveBeenCalledWith(ID, 2, { endedAt: expect.any(Date), recordingEndMs: 0 });

    expect(result).toMatchObject({
      status: 'STOPPED',
      processing: 'IDLE',
      encounterSeq: 2,
      finalTranscript: { state: 'complete', contextItemId: 'ft-1', versionNumber: 4, segmentCount: 12, lastSegmentSeq: 12 },
    });
  });

  it('a SUMMARIZING the note writer sets during the wait survives the stop, even when it lands after the post-wait read', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 1 }));
    // The row as the database holds it once the stop persisted FINALIZING_TRANSCRIPT.
    let db: ConsultationProcessing = ConsultationProcessing.FINALIZING_TRANSCRIPT;
    let waited = false;
    let postWaitReads = 0;
    h.transcriptRecord.awaitFinal.mockImplementationOnce(async () => {
      waited = true;
      return 'complete' as const;
    });
    h.consultations.findByIdOrNull.mockImplementation(async () => {
      const current = h.current()!;
      if (!waited) return current;
      const snapshot = Object.assign(Object.create(Object.getPrototypeOf(current)), current) as ConsultationEntity;
      snapshot.setProcessing(db);
      // The governed note's SUMMARIZING lands right after this read.
      if (postWaitReads++ === 0) db = ConsultationProcessing.SUMMARIZING;
      return snapshot;
    });
    h.consultations.setProcessing.mockImplementation((async (
      _id: string,
      processing: ConsultationProcessing,
      options: { onlyIfProcessing?: ConsultationProcessing } = {},
    ) => {
      if (options.onlyIfProcessing !== undefined && options.onlyIfProcessing !== db) return false;
      db = processing;
      return true;
    }) as never);

    const result = await h.service.stop(ID);

    expect(db).toBe(ConsultationProcessing.SUMMARIZING);
    expect(result).toMatchObject({ status: 'STOPPED', processing: 'SUMMARIZING', finalTranscript: { state: 'complete' } });
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

  it('claims encounterStoppedRedisKey with SET NX before emitting EncounterStopped', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 2 }));
    const order: string[] = [];
    h.markers.eval.mockImplementation(async () => (order.push('claim'), 'OK'));
    h.eventEmitter.emit.mockImplementation((name: string) => {
      if (name === ConsultationPipelineEvent.EncounterStopped) order.push('emit');
      return true;
    });

    await h.service.stop(ID);

    const [script, numKeys, key] = h.markers.eval.mock.calls[0] as unknown as [string, number, string];
    expect(script).toContain("'NX'");
    expect(numKeys).toBe(1);
    expect(key).toBe(encounterStoppedRedisKey(ID, 2));
    expect(order).toEqual(['claim', 'emit']);
  });

  it('emits no EncounterStopped when the session final already claimed the encounter (fires once), and still answers complete', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 2 }));
    h.markers.eval.mockResolvedValue(null);

    const result = await h.service.stop(ID);

    expect(h.eventEmitter.emit.mock.calls.some(([name]) => name === ConsultationPipelineEvent.EncounterStopped)).toBe(false);
    expect(result.finalTranscript.state).toBe('complete');
    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['stopped', 'transcript_final']);
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
    // the response carries the episode view (encounters, approval, auto-close, reopen policy)
    expect(h.encounterService.lifecycleView).toHaveBeenCalledWith(h.current());
  });

  it('APPROVED → CLOSED_COMPLETE with closedReason APPROVED (D-29)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.APPROVED }));
    const response = await h.service.close(ID);
    expect(response.status).toBe('CLOSED_COMPLETE');
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.APPROVED);
  });

  // TASK-972 OD-7 (re-homed from consultation.service.test.ts): a never-recorded OPEN
  // consultation can be closed by hand — cancelling it — rather than stranding forever.
  it('a manual close of a never-recorded OPEN consultation → CLOSED_INCOMPLETE (MANUAL), persisted', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN }));
    const response = await h.service.close(ID);
    expect(response.status).toBe('CLOSED_INCOMPLETE');
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.MANUAL);
    expect(h.consultations.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('an auto close stamps closedReason AUTO', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN }));
    await h.service.close(ID, { auto: true });
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.AUTO);
  });

  it('an auto close from the tenantless sweep is the system’s, and writes the SESSION_CLOSED_INCOMPLETE WORM row', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED }), { tenantId: null, user: null });
    const response = await h.service.close(ID, { auto: true });
    expect(response.status).toBe('CLOSED_INCOMPLETE');
    expect(h.current()?.closedReason).toBe(ConsultationClosedReason.AUTO);
    expect(h.harnessAudit.append).toHaveBeenCalledTimes(1);
    expect(h.harnessAudit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        consultationId: ID,
        action: HarnessAuditAction.SESSION_CLOSED_INCOMPLETE,
        clinicianId: null,
        createdBy: null,
      }),
    );
  });

  it('a manual close writes the WORM row naming the closing clinician; a failed append never fails the close', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.APPROVED }));
    h.harnessAudit.append.mockRejectedValueOnce(new Error('audit down'));
    const response = await h.service.close(ID);
    expect(response.status).toBe('CLOSED_COMPLETE');
    expect(h.harnessAudit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: HarnessAuditAction.SESSION_CLOSED_COMPLETE, clinicianId: DOCTOR, createdBy: DOCTOR }),
    );
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
    const h = makeHarness(
      consultation({ status: ConsultationStatus.CLOSED_INCOMPLETE, closedReason: ConsultationClosedReason.AUTO, closedAt: new Date() }),
    );
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
    expect(allowed.settings.resolveEffective).toHaveBeenCalledWith(
      'consultation.reopen.allowClosedComplete',
      expect.objectContaining({ tenantId: TENANT }),
    );
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
    expect(await rejectionOf(makeHarness(consultation({ tenantId: OTHER_TENANT })).gate.assertContentWritable(ID))).toBeInstanceOf(NotFoundException);
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

  it('setProcessing that changes only the reason persists it without a version bump and emits processing_changed', async () => {
    const h = makeHarness(
      consultation({
        status: ConsultationStatus.STOPPED,
        processing: ConsultationProcessing.AWAITING_REVIEW,
        processingReason: 'NOTE_COVERAGE_GAPS:2',
      }),
    );
    await h.gate.setProcessing(ID, ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:1');
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.AWAITING_REVIEW, { reason: 'NOTE_COVERAGE_GAPS:1' });
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([
      expect.objectContaining({ type: 'processing_changed', processing: 'AWAITING_REVIEW', processingReason: 'NOTE_COVERAGE_GAPS:1', version: 3 }),
    ]);
  });

  it('setProcessing with the same processing and the same reason emits nothing', async () => {
    const h = makeHarness(
      consultation({
        status: ConsultationStatus.STOPPED,
        processing: ConsultationProcessing.AWAITING_REVIEW,
        processingReason: 'NOTE_COVERAGE_GAPS:2',
      }),
    );
    await h.gate.setProcessing(ID, ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:2');
    expect(h.consultations.setProcessing).toHaveBeenCalledTimes(1);
    expect(h.lifecycleEvents()).toEqual([]);
  });

  it('a written note on an already-IDLE consultation passes NOTE_READY to the writer (D-34)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE }));
    await h.gate.setProcessing(ID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.IDLE, { reason: NOTE_READY_REASON });
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  // Live only once the domain's reason rule keeps a reason on IDLE (D-34): until then the writer
  // clears NOTE_READY, so there is no reason change to announce.
  it.skipIf(ConsultationEntity.processingReasonFor(ConsultationProcessing.IDLE, NOTE_READY_REASON) === null)(
    'a written note on an already-IDLE consultation announces NOTE_READY (D-34)',
    async () => {
      const h = makeHarness(consultation({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.IDLE }));
      await h.gate.setProcessing(ID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
      expect(h.lifecycleEvents()).toEqual([
        expect.objectContaining({ type: 'processing_changed', processing: 'IDLE', processingReason: NOTE_READY_REASON }),
      ]);
    },
  );

  it('touchActivity and currentEncounterSeq', async () => {
    const h = makeHarness(consultation({ currentEncounterSeq: 3 }));
    await h.gate.touchActivity(ID);
    expect(h.consultations.touchActivity).toHaveBeenCalledWith(ID);
    expect(await h.gate.currentEncounterSeq(ID)).toBe(3);
  });
});

describe('ConsultationLifecycleEventPublisher — events emitted elsewhere (open / encounter_appended)', () => {
  it('sequences an unsequenced LifecycleChanged, buffers + publishes the frame and fans out the sys-event', async () => {
    const h = makeHarness(consultation());
    await h.publisher.onLifecycleChanged({
      consultationId: ID,
      tenantId: TENANT,
      timestamp: '2026-10-05T08:00:00.000Z',
      event: {
        type: 'opened',
        consultationId: ID,
        status: 'OPEN',
        processing: 'IDLE',
        encounterSeq: 1,
        version: 1,
        at: '2026-10-05T08:00:00.000Z',
        seq: 0,
      },
    });
    const frame = JSON.parse(String(h.cache.eval.mock.calls[0].find((a: unknown) => typeof a === 'string' && a.startsWith('{'))));
    expect(frame).toMatchObject({ type: 'opened', seq: 7, version: 1 });
    expect(h.sysEvents()).toEqual([expect.objectContaining({ data: expect.objectContaining({ action: 'lifecycle', event: 'opened', seq: 7 }) })]);
  });

  it('ignores the events it published itself (already sequenced)', async () => {
    const h = makeHarness(consultation());
    await h.publisher.onLifecycleChanged({
      consultationId: ID,
      tenantId: TENANT,
      timestamp: 'x',
      event: { type: 'started', consultationId: ID, status: 'RECORDING', processing: 'IDLE', version: 2, at: 'x', seq: 3 },
    });
    expect(h.cache.incr).not.toHaveBeenCalled();
    expect(h.sysEvents()).toEqual([]);
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

  // A written note waits for the clinician with processing IDLE + reason NOTE_READY; an older
  // client knew that moment as PENDING_REVIEW. Stopped + IDLE with no note yet stays DRAINING.
  it('STOPPED + IDLE + NOTE_READY → PENDING_REVIEW; without the reason it stays DRAINING', () => {
    expect(projectLegacyConsultationStatus('STOPPED', 'IDLE', NOTE_READY_REASON)).toBe('PENDING_REVIEW');
    expect(projectLegacyConsultationStatus('STOPPED', 'IDLE', null)).toBe('DRAINING');
    expect(projectLegacyConsultationStatus('STOPPED', 'SUMMARIZING', NOTE_READY_REASON)).toBe('DRAFT_PENDING_SENSORS');
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

describe('ConsultationLifecycleService — stop never restores the previous encounter’s note state (E2E-31)', () => {
  // Live 2026-10-05: encounter 1's note left STOPPED + AWAITING_REVIEW (NOTE_COVERAGE_GAPS:3);
  // the encounter-2 stop restored AWAITING_REVIEW with an empty reason for ~9 s, so a client
  // reading isNoteReady showed encounter 1's note as the current one.
  it.each([
    [ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:3'],
    [ConsultationProcessing.FAILED, 'OUTPUT_INVALID'],
    [ConsultationProcessing.IDLE, NOTE_READY_REASON],
  ])('a stop after new recording settles %s (%s) back to IDLE with no reason', async (processing, reason) => {
    const h = makeHarness(
      consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 2, processing, processingReason: reason } as Partial<Row>),
    );

    const result = await h.service.stop(ID);

    const written = h.consultations.updateWithVersion.mock.calls[0][1] as ConsultationEntity;
    expect(written.processingPrior ?? null).toBeNull();
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(ID, ConsultationProcessing.IDLE, expect.objectContaining({ prior: null }));
    expect(result).toMatchObject({ status: 'STOPPED', processing: 'IDLE' });
    const final = h.lifecycleEvents().find((e) => e.type === 'transcript_final') as unknown as {
      processing: string;
      processingReason: string | null;
    };
    expect(final.processing).toBe('IDLE');
    expect(final.processingReason ?? null).toBeNull();
  });

  it.each([ConsultationProcessing.SUMMARIZING, ConsultationProcessing.PROCESSING_ATTACHMENT])(
    'work still in flight (%s) is restored',
    async (processing) => {
      const h = makeHarness(consultation({ status: ConsultationStatus.RECORDING, currentEncounterSeq: 2, processing }));

      const result = await h.service.stop(ID);

      expect(result.processing).toBe(processing);
    },
  );

  it('a pending stop records no stale note state for the transcript record to restore', async () => {
    const h = makeHarness(
      consultation({
        status: ConsultationStatus.RECORDING,
        processing: ConsultationProcessing.AWAITING_REVIEW,
        processingReason: 'NOTE_COVERAGE_GAPS:3',
      } as Partial<Row>),
    );
    h.transcriptRecord.awaitFinal.mockResolvedValueOnce('pending');

    await h.service.stop(ID);

    const written = h.consultations.updateWithVersion.mock.calls[0][1] as ConsultationEntity;
    expect(written.processing).toBe(ConsultationProcessing.FINALIZING_TRANSCRIPT);
    expect(written.processingPrior ?? null).toBeNull();
  });
});
