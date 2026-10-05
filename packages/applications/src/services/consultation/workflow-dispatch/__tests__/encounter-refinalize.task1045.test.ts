/**
 * TASK-1045 H-169 — every stop that adds speech to a consultation whose note already exists
 * re-finalises the WHOLE consultation exactly once, on both lanes:
 *
 *  - governed (a tenant workflow governs): the governing run is SUPERSEDED (TASK-1022), and the
 *    fresh run reads a note plan composed for the current transcript (never the earlier encounter's);
 *  - non-governed: one `harness-doc` start with `supersede: true` carrying the composed plan.
 *
 * A stop retry and an explicit `summary/async` right after the stop coalesce on the same
 * transcript state (the FULL_TRANSCRIPT version). Encounter 1's first stop is unchanged (the
 * auto-pipeline / the open-time governing run own it). H-166 stays fixed: nothing finalises a
 * consultation that is still OPEN. H-157: a run row is never left RUNNING when its start fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';

import { EncounterRefinalizeService } from '../encounter-refinalize.service';
import { classifySessionFinal, noteRefinalizeClaimKey, refinalizeStateKey } from '../encounter-refinalize';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';
import { ConsultationPipelineEvent } from '../../events/consultation.events';
import { LiveDocumentationService } from '../../live-documentation/live-documentation.service';
import { ConsultationLifecycleService } from '../../lifecycle/consultation-lifecycle.service';
import { ConsultationLifecycleGate } from '../../lifecycle/consultation-lifecycle.gate';
import { ConsultationLifecycleEventPublisher } from '../../lifecycle/lifecycle-event.publisher';

const TENANT = 'tenant-1045';
const CID = 'c-episode';
const FT = 'ft-1';
const PLAN = { consultationId: CID, mode: 'final' as const, planId: 'plan-e2' };
const GOVERNED_META = { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-e1', workflowDefinitionSlug: 'arcaai-consultation' } };

type Row = {
  id: string;
  tenantId: string;
  status: string;
  processing: string;
  processingReason?: string | null;
  currentEncounterSeq: number;
  segmentSeqHead?: number;
  doctorId: string;
  departmentId: string | null;
  patientId: string;
  metadata: Record<string, unknown> | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: CID,
    tenantId: TENANT,
    status: 'STOPPED',
    processing: 'IDLE',
    processingReason: null,
    currentEncounterSeq: 2,
    segmentSeqHead: 40,
    doctorId: 'doctor-1',
    departmentId: null,
    patientId: 'patient-1',
    metadata: null,
    ...overrides,
  };
}

function fullTranscript(version: number) {
  return { id: FT, consultationId: CID, tenantId: TENANT, type: 'FULL_TRANSCRIPT', currentVersionNumber: version, content: 'E1 … E2 …' };
}

/** A Redis double with real SET NX / GET / DEL semantics on the claim keys. */
function redisDouble() {
  const store = new Map<string, string>();
  return {
    store,
    eval: vi.fn(async (script: string, _n: number, key: string, value: string) => {
      if (script.includes("'NX'")) {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => void store.delete(key)),
  };
}

function build(opts: { consultation?: Row; version?: number } = {}) {
  let current = opts.consultation ?? row();
  const item = fullTranscript(opts.version ?? 3);
  const consultations = {
    findByIdOrNull: vi.fn(async () => ({ ...current })),
    setRow: (next: Partial<Row>) => (current = { ...current, ...next }),
  };
  const contextItems = {
    findByIdOrNull: vi.fn(async (id: string) => (id === FT ? item : null)),
    findFullTranscript: vi.fn(async () => item),
    findByType: vi.fn(async () => []),
  };
  const harnessGateway = { start: vi.fn().mockResolvedValue({ status: 'started' }) };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() };
  const composer = { composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: PLAN, strategy: 'single_pass', callCount: 1, promptTokens: 900 }) };
  const dispatch = {
    supersedeGoverningRun: vi.fn().mockResolvedValue({ superseded: true, runId: 'run-e2', supersededRunId: 'run-e1' }),
  };
  const redis = redisDouble();
  const gate = {
    setProcessing: vi.fn(async (_id: string, processing: string, reason?: string) => {
      current = { ...current, processing, processingReason: reason ?? null };
    }),
  };
  const service = new EncounterRefinalizeService(
    consultations as never,
    contextItems as never,
    harnessGateway as never,
    cls as never,
    composer as never,
    dispatch as never,
    redis as never,
    gate as never,
  );
  return { service, consultations, contextItems, harnessGateway, composer, dispatch, redis, gate, item };
}

const stopEvent = { consultationId: CID, tenantId: TENANT, contextItemId: FT, transcriptionSource: 'streaming' as const, timestamp: 't' };

describe('classifySessionFinal — which session finals re-finalise', () => {
  const ft = (v: number) => ({ type: 'FULL_TRANSCRIPT', currentVersionNumber: v });

  it('encounter 1, first transcript version: not ours (the auto-pipeline / open-time run own it)', () => {
    expect(classifySessionFinal({ status: 'STOPPED', currentEncounterSeq: 1 }, ft(1))).toBe('first');
  });

  it('encounter 2, or a later transcript version, on a STOPPED consultation: re-finalise', () => {
    expect(classifySessionFinal({ status: 'STOPPED', currentEncounterSeq: 2 }, ft(1))).toBe('refinalize');
    expect(classifySessionFinal({ status: 'STOPPED', currentEncounterSeq: 1 }, ft(2))).toBe('refinalize');
  });

  it('H-166 — never while the consultation can still capture (OPEN / RECORDING / PAUSED)', () => {
    for (const status of ['OPEN', 'RECORDING', 'PAUSED']) {
      expect(classifySessionFinal({ status, currentEncounterSeq: 2 }, ft(3))).toBe('not-stopped');
    }
  });

  it('never on an approved or closed consultation, and never for a non-FULL_TRANSCRIPT item', () => {
    expect(classifySessionFinal({ status: 'APPROVED', currentEncounterSeq: 2 }, ft(3))).toBe('locked');
    expect(classifySessionFinal({ status: 'CLOSED_COMPLETE', currentEncounterSeq: 2 }, ft(3))).toBe('locked');
    expect(classifySessionFinal({ status: 'STOPPED', currentEncounterSeq: 2 }, { type: 'TRANSCRIPT', currentVersionNumber: 1 })).toBe(
      'not-full-transcript',
    );
    expect(classifySessionFinal({ status: 'STOPPED', currentEncounterSeq: 2 }, null)).toBe('not-full-transcript');
  });
});

describe('EncounterRefinalizeService — encounter 2 stop', () => {
  it('listens to the session-final event (TranscriptionCreated)', () => {
    const listeners = Reflect.getMetadata('EVENT_LISTENER_METADATA', EncounterRefinalizeService.prototype.onTranscriptionCreated) as
      { event: string }[] | undefined;
    expect(listeners?.map((l) => l.event)).toContain(ConsultationPipelineEvent.TranscriptionCreated);
  });

  it('governed: ONE supersede of the governing run, keyed on the transcript state, processing → SUMMARIZING; no harness-doc start', async () => {
    const h = build({ consultation: row({ metadata: GOVERNED_META }) });

    const outcome = await h.service.onTranscriptionCreated(stopEvent);

    expect(outcome).toMatchObject({ kind: 'started', lane: 'governed', jobId: 'run-e2' });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: CID, tenantId: TENANT, triggerId: `refinalize:${refinalizeStateKey(h.item)}` }),
    );
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.SUMMARIZING);
  });

  it('non-governed: ONE harness-doc start that supersedes the parked run and carries the composed plan', async () => {
    const h = build();

    const outcome = await h.service.onTranscriptionCreated(stopEvent);

    expect(outcome).toMatchObject({ kind: 'started', lane: 'harness-doc' });
    expect(h.composer.composeNotePlan).toHaveBeenCalledWith(CID, expect.objectContaining({ tenantId: TENANT, mode: 'final' }));
    expect(h.harnessGateway.start).toHaveBeenCalledTimes(1);
    const [cid, ctx] = h.harnessGateway.start.mock.calls[0] as [string, Record<string, unknown>];
    expect(cid).toBe(CID);
    expect(ctx).toMatchObject({ tenantId: TENANT, supersede: true, notePlanRef: PLAN, contextItemId: FT, externalPatientId: 'patient-1' });
    expect(ctx.jobId).toEqual((outcome as { jobId: string }).jobId);
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.SUMMARIZING);
  });

  it('a second delivery of the same stop (retry) starts nothing more', async () => {
    const h = build();
    const first = await h.service.onTranscriptionCreated(stopEvent);
    const second = await h.service.onTranscriptionCreated(stopEvent);

    expect(second).toMatchObject({ kind: 'coalesced', jobId: (first as { jobId: string }).jobId });
    expect(h.harnessGateway.start).toHaveBeenCalledTimes(1);
  });

  it('encounter 1 first stop is unchanged — nothing composed, started, superseded or written', async () => {
    const h = build({ consultation: row({ currentEncounterSeq: 1 }), version: 1 });

    expect(await h.service.onTranscriptionCreated(stopEvent)).toEqual({ kind: 'not-refinalize', reason: 'first' });
    expect(h.composer.composeNotePlan).not.toHaveBeenCalled();
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).not.toHaveBeenCalled();
  });

  it('H-166 — a session final on an OPEN consultation finalises nothing', async () => {
    const h = build({ consultation: row({ status: 'OPEN', metadata: GOVERNED_META }) });

    expect(await h.service.onTranscriptionCreated(stopEvent)).toEqual({ kind: 'not-refinalize', reason: 'not-stopped' });
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });
});

describe('EncounterRefinalizeService — summary/async right after the stop', () => {
  it('stop first, then summary/async: coalesced onto the stop’s run (same job id, no second start)', async () => {
    const h = build();
    const stop = await h.service.onTranscriptionCreated(stopEvent);
    const explicit = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-explicit' });

    expect(explicit).toMatchObject({ kind: 'coalesced', jobId: (stop as { jobId: string }).jobId });
    expect(h.harnessGateway.start).toHaveBeenCalledTimes(1);
  });

  it('summary/async first, then the stop event: the stop coalesces onto the explicit run', async () => {
    const h = build();
    const explicit = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-explicit' });
    const stop = await h.service.onTranscriptionCreated(stopEvent);

    expect(explicit).toMatchObject({ kind: 'started', lane: 'harness-doc', jobId: 'harness-doc-explicit' });
    expect(stop).toMatchObject({ kind: 'coalesced', jobId: 'harness-doc-explicit' });
    expect(h.harnessGateway.start).toHaveBeenCalledTimes(1);
  });

  it('governed: summary/async after the stop is coalesced too — never the default engine', async () => {
    const h = build({ consultation: row({ metadata: GOVERNED_META }) });
    await h.service.onTranscriptionCreated(stopEvent);
    const explicit = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-explicit' });

    expect(explicit).toMatchObject({ kind: 'coalesced', lane: 'governed', jobId: 'run-e2' });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
  });

  it('once the note is written (processing IDLE + NOTE_READY), summary/async is a real regenerate', async () => {
    const h = build();
    await h.service.onTranscriptionCreated(stopEvent);
    h.consultations.setRow({ processing: 'IDLE', processingReason: 'NOTE_READY' });

    const regen = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-regen' });

    expect(regen).toMatchObject({ kind: 'started', jobId: 'harness-doc-regen' });
    expect(h.harnessGateway.start).toHaveBeenCalledTimes(2);
    expect((h.harnessGateway.start.mock.calls[1] as [string, Record<string, unknown>])[1]).toMatchObject({ supersede: true });
  });

  it('governed, encounter 1, the open-time run still running: summary/async joins it — no supersede, no default engine', async () => {
    const h = build({ consultation: row({ currentEncounterSeq: 1, metadata: GOVERNED_META }), version: 1 });
    const explicit = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-e1' });

    expect(explicit).toEqual({ kind: 'coalesced', lane: 'governed', jobId: null });
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).not.toHaveBeenCalled();
  });

  it('governed, encounter 1, the run ended and the note is written: summary/async is a governed regenerate', async () => {
    const ended = { governingEngine: { ...GOVERNED_META.governingEngine, runStatus: 'COMPLETED' } };
    const h = build({
      consultation: row({ currentEncounterSeq: 1, metadata: ended, processing: 'IDLE', processingReason: 'NOTE_READY' }),
      version: 1,
    });
    const regen = await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-e1' });

    expect(regen).toMatchObject({ kind: 'started', lane: 'governed' });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
  });

  it('on a first-encounter consultation summary/async is not ours (the seam proceeds as before)', async () => {
    const h = build({ consultation: row({ currentEncounterSeq: 1 }), version: 1 });
    expect(await h.service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, jobId: 'j' })).toEqual({
      kind: 'not-refinalize',
      reason: 'first',
    });
  });
});

describe('EncounterRefinalizeService — failures are visible and release the claim', () => {
  it('governed supersede that fails → processing FAILED NOTE_REFINALIZE_FAILED; the next request may try again', async () => {
    const h = build({ consultation: row({ metadata: GOVERNED_META }) });
    h.dispatch.supersedeGoverningRun.mockResolvedValueOnce({
      superseded: false,
      runId: 'run-e1',
      supersededRunId: null,
      skippedReason: 'failed',
      reason: 'x',
    });

    expect(await h.service.onTranscriptionCreated(stopEvent)).toMatchObject({ kind: 'failed', lane: 'governed' });
    expect(h.gate.setProcessing).toHaveBeenLastCalledWith(CID, ConsultationProcessing.FAILED, 'NOTE_REFINALIZE_FAILED');
    expect(h.redis.store.has(noteRefinalizeClaimKey(CID, refinalizeStateKey(h.item)))).toBe(false);
  });

  it('a plan that cannot fit the window fails closed with that code and starts nothing', async () => {
    const h = build();
    h.composer.composeNotePlan.mockRejectedValueOnce(new UnprocessableEntityException({ code: 'NOTE_INPUT_EXCEEDS_CONTEXT', message: 'too big' }));

    expect(await h.service.onTranscriptionCreated(stopEvent)).toMatchObject({ kind: 'failed', reason: 'NOTE_INPUT_EXCEEDS_CONTEXT' });
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).toHaveBeenLastCalledWith(CID, ConsultationProcessing.FAILED, 'NOTE_INPUT_EXCEEDS_CONTEXT');
  });

  it('a harness start that throws → FAILED NOTE_REFINALIZE_FAILED (no message persisted)', async () => {
    const h = build();
    h.harnessGateway.start.mockRejectedValueOnce(new Error('harness down'));

    expect(await h.service.onTranscriptionCreated(stopEvent)).toMatchObject({ kind: 'failed', lane: 'harness-doc' });
    expect(h.gate.setProcessing).toHaveBeenLastCalledWith(CID, ConsultationProcessing.FAILED, 'NOTE_REFINALIZE_FAILED');
  });
});

// ── the governed run's plan covers the whole consultation ─────────────────────────────────────

function liveDoc(record: unknown, consultation: Partial<Row>) {
  const stored = new Map<string, string>();
  stored.set(`live-doc:handoff:${CID}`, JSON.stringify(record));
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    exists: vi.fn(async (key: string) => stored.has(key)),
    set: vi.fn(),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void stored.set(key, value)),
    publish: vi.fn(),
    del: vi.fn(),
  };
  const composer = { composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: PLAN, strategy: 'single_pass', callCount: 1 }) };
  const args: unknown[] = new Array(34).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = { findById: vi.fn(async () => ({ ...row(), ...consultation })) };
  args[32] = composer;
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, composer, stored };
}

describe('readLiveHandoff — the superseding run reads a plan for the CURRENT transcript', () => {
  const E1_PLAN = { consultationId: CID, mode: 'final', planId: 'plan-e1' };

  it('a plan remembered for an earlier segment head (encounter 1) is recomposed', async () => {
    const record = { endedAt: 't', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'], notePlanRef: E1_PLAN, notePlanSegmentHead: 12 };
    const { service, composer } = liveDoc(record, { status: 'STOPPED', segmentSeqHead: 40 });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(composer.composeNotePlan).toHaveBeenCalledTimes(1);
    expect(answer.outputs).toEqual({ n_summary: { text: '', note_plan_ref: PLAN } });
  });

  it('a plan remembered for the current segment head is reused (no second composition)', async () => {
    const record = { endedAt: 't', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'], notePlanRef: E1_PLAN, notePlanSegmentHead: 40 };
    const { service, composer } = liveDoc(record, { status: 'STOPPED', segmentSeqHead: 40 });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(composer.composeNotePlan).not.toHaveBeenCalled();
    expect(answer.outputs).toEqual({ n_summary: { text: '', note_plan_ref: E1_PLAN } });
  });

  it('remembers the segment head it composed for', async () => {
    const record = { endedAt: 't', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };
    const { service, stored } = liveDoc(record, { status: 'STOPPED', segmentSeqHead: 40 });

    await service.readLiveHandoff(CID, ['n_summary']);

    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!)).toMatchObject({ notePlanRef: PLAN, notePlanSegmentHead: 40 });
  });

  it('H-166 — a governed run polling at OPEN (no transcript yet) is told "not ended" and composes nothing', async () => {
    const { service, composer } = liveDoc(
      { endedAt: 't', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] },
      { status: 'OPEN', segmentSeqHead: 0 },
    );

    expect(await service.readLiveHandoff(CID, ['n_summary'])).toEqual({ ended: false, outputs: {}, context: {} });
    expect(composer.composeNotePlan).not.toHaveBeenCalled();
  });
});

// ── stop() never clobbers the re-finalisation's SUMMARIZING ───────────────────────────────────

describe('ConsultationLifecycleService.stop — the processing the re-finalisation wrote during the wait survives', () => {
  function lifecycle(processingAfterWait: ConsultationProcessing) {
    let current = new ConsultationEntity({
      id: CID,
      tenantId: TENANT,
      patientId: 'patient-1',
      doctorId: 'doctor-1',
      departmentId: null,
      appointmentDate: new Date('2026-10-05'),
      status: ConsultationStatus.RECORDING,
      processing: ConsultationProcessing.IDLE,
      currentEncounterSeq: 2,
      segmentSeqHead: 40,
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ConstructorParameters<typeof ConsultationEntity>[0]);
    let waited = false;
    const consultations = {
      findByIdOrNull: vi.fn(async () => {
        if (!waited) return current;
        const settled = Object.assign(Object.create(Object.getPrototypeOf(current)), current) as ConsultationEntity;
        Object.assign(settled, { _processing: processingAfterWait });
        settled.setProcessing(processingAfterWait);
        return settled;
      }),
      updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => {
        current = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity) as ConsultationEntity;
        Object.assign(current, { _version: entity.version + 1, _changes: {} });
        return current;
      }),
      setProcessing: vi.fn(async () => true),
      touchActivity: vi.fn(async () => true),
    };
    const clsService = {
      get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'doctor-1', roles: [] } : undefined)),
      set: vi.fn(),
      getId: vi.fn(),
    };
    const eventEmitter = { emit: vi.fn() };
    const publisher = new ConsultationLifecycleEventPublisher(
      eventEmitter as never,
      clsService as never,
      { incr: vi.fn(async () => 1), eval: vi.fn() } as never,
      undefined,
    );
    const gate = new ConsultationLifecycleGate(consultations as never, publisher, clsService as never);
    const service = new ConsultationLifecycleService(
      consultations as never,
      { endEncounter: vi.fn(), findBySeq: vi.fn(), update: vi.fn() } as never,
      { findFullTranscript: vi.fn(async () => ({ id: FT, currentVersionNumber: 3, metaData: { segmentCount: 40 } })) } as never,
      { approve: vi.fn() } as never,
      gate,
      publisher,
      eventEmitter as never,
      clsService as never,
      { findAll: vi.fn(async () => [{ streamSessionId: 'stt-a', createdAt: new Date() }]), update: vi.fn() } as never,
      { getSessionStatus: vi.fn(async () => ({ status: 'active' })) } as never,
      { writeControlCommand: vi.fn() } as never,
      {
        awaitFinal: vi.fn(async () => {
          waited = true;
          return 'complete' as const;
        }),
      } as never,
      { resolveEffective: vi.fn(async () => ({ value: 10 })) } as never,
      undefined,
      { eval: vi.fn(async () => 'OK') } as never,
    );
    return { service, consultations };
  }

  it('SUMMARIZING written during the wait is kept and reported', async () => {
    const h = lifecycle(ConsultationProcessing.SUMMARIZING);
    const result = await h.service.stop(CID);

    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'STOPPED', processing: 'SUMMARIZING' });
  });

  it('still FINALIZING_TRANSCRIPT after the wait → restored as before', async () => {
    const h = lifecycle(ConsultationProcessing.FINALIZING_TRANSCRIPT);
    const result = await h.service.stop(CID);

    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, expect.objectContaining({ prior: null }));
    expect(result).toMatchObject({ processing: 'IDLE' });
  });
});

// ── H-157: a governed run row is never left RUNNING when its start fails ──────────────────────

describe('ConsultationWorkflowDispatchService — a failed harness start marks its run row FAILED', () => {
  const definition = {
    id: 'wd-1',
    slug: 'arcaai-consultation',
    versionNumber: 1,
    name: 'ArcaAI',
    paletteKey: 'core',
    compiledConfig: { formatVersion: 1, stages: [] },
  };

  function dispatchDeps() {
    let current: Record<string, unknown> = {
      id: CID,
      tenantId: TENANT,
      doctorId: 'doctor-1',
      patientId: 'patient-1',
      version: 3,
      metadata: GOVERNED_META,
    };
    return {
      assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: definition.slug, source: 'tenant' }) },
      definitionRepository: { findById: vi.fn().mockResolvedValue(definition), findPublishedBySlug: vi.fn().mockResolvedValue(definition) },
      consultationRepository: {
        findById: vi.fn(async () => structuredClone(current)),
        update: vi.fn(),
        updateWithVersion: vi.fn(async (_id: string, entity: Record<string, unknown>) => {
          current = { ...structuredClone(entity), version: (current.version as number) + 1 };
          return current;
        }),
      },
      workflowRunService: {
        getRun: vi.fn().mockResolvedValue({ runId: 'run-e1', workflowVersionId: definition.id }),
        recordRunStarted: vi.fn().mockResolvedValue({}),
        recordRunFinished: vi.fn().mockResolvedValue({}),
        recordRunSuperseded: vi.fn().mockResolvedValue({}),
      },
      harnessGateway: {
        startWorkflowRun: vi.fn().mockRejectedValue(new Error('harness down with PHI-ish text')),
        terminateWorkflowRun: vi.fn(),
      },
      s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    };
  }
  const make = (d: ReturnType<typeof dispatchDeps>) =>
    new ConsultationWorkflowDispatchService(
      d.assignments as never,
      d.definitionRepository as never,
      d.consultationRepository as never,
      d.workflowRunService as never,
      d.harnessGateway as never,
      d.s3Service as never,
    );

  let d: ReturnType<typeof dispatchDeps>;
  beforeEach(() => {
    d = dispatchDeps();
  });

  it('supersede: the new run row is marked FAILED RUN_START_FAILED (code only) and the result is failed', async () => {
    const result = await make(d).supersedeGoverningRun({ consultationId: CID, tenantId: TENANT, triggerId: 'refinalize:ft-1:v3' });

    expect(result).toMatchObject({ superseded: false, skippedReason: 'failed' });
    expect(d.workflowRunService.recordRunFinished).toHaveBeenCalledTimes(1);
    const arg = d.workflowRunService.recordRunFinished.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ tenantId: TENANT, status: 'FAILED', firstErrorCode: 'RUN_START_FAILED' });
    expect(arg.runId).toBe((d.workflowRunService.recordRunStarted.mock.calls[0]![0] as { runId: string }).runId);
    expect(JSON.stringify(arg)).not.toContain('PHI-ish');
  });

  it('dispatch at open: the anchored run row is marked FAILED RUN_START_FAILED, even when marking it fails too', async () => {
    d.workflowRunService.recordRunFinished.mockRejectedValueOnce(new Error('db down'));
    const result = await make(d).dispatchForConsultation({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' } as never);

    expect(result.dispatched).toBe(false);
    expect(d.workflowRunService.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, status: 'FAILED', firstErrorCode: 'RUN_START_FAILED' }),
    );
  });
});
