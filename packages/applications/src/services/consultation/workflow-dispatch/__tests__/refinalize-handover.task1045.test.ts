/**
 * TASK-1045 W6-REFIN2 — the hand-overs around `EncounterRefinalizeService`:
 *
 *  1. the auto-pipeline handler stands down on a session final the re-finalisation owns (otherwise
 *     a non-governed encounter-2 stop starts TWO harness-doc runs);
 *  2. `summary/async` (`SUMMARY_REGENERATE`) goes through the same coordinator, and the job id it
 *     hands back always reaches a terminal state — a governing run carries no job id, so the
 *     caller's own job is watched and settled by the lifecycle change that writes (or fails) the note;
 *  4. the note-inputs guidance carries every encounter's safety facts forward.
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';

import { ConsultationEventHandler } from '../../events/consultation-event.handler';
import { DEFAULT_PIPELINE_CONFIG, type LifecycleChangedPayload, type TranscriptionCreatedPayload } from '../../events/consultation.events';
import { NoteGenerationService, noteJobWatchKey } from '../../note-generation/note-generation.service';
import { GenerationTrigger } from '../../note-generation/types';
import { EncounterRefinalizeService } from '../encounter-refinalize.service';
import { ConsultationJobService, IConsultationJobService } from '../../jobs/consultation-job.service';
import { NOTE_INPUTS_GUIDANCE } from '../../prompt/prompt-assembly.service';

const TENANT = 'tenant-1045';
const CID = 'c-episode';
const FT = 'ft-1';

// ── 1. the auto-pipeline handler ──────────────────────────────────────────────────────────────

function handlerWorld(opts: { encounterSeq: number; version: number; status?: string; withItems?: boolean }) {
  const consultation = {
    id: CID,
    tenantId: TENANT,
    status: opts.status ?? 'STOPPED',
    currentEncounterSeq: opts.encounterSeq,
    patientId: 'patient-1',
    metadata: null,
  };
  const item = { id: FT, consultationId: CID, type: 'FULL_TRANSCRIPT', currentVersionNumber: opts.version, content: 'E1 … E2 …' };
  const consultationRepository = { findById: vi.fn(async () => consultation), findByIdOrNull: vi.fn(async () => consultation) };
  const contextItemRepository = {
    findById: vi.fn(async () => item),
    findByIdOrNull: vi.fn(async (id: string) => (id === FT ? item : null)),
    findTranscripts: vi.fn(async () => []),
    findByType: vi.fn(async () => []),
  };
  const noteGenerationService = {
    generate: vi.fn().mockResolvedValue({ generator: 'harness', harnessJobId: 'harness-doc-x' }),
    resolveConfig: vi.fn(async () => ({ ...DEFAULT_PIPELINE_CONFIG, autoSummaryEnabled: true })),
  };
  const workflowDispatch = { supersedeGoverningRun: vi.fn() };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() };
  const handler = new ConsultationEventHandler(
    consultationRepository as never,
    { emit: vi.fn() } as never,
    cls as never,
    noteGenerationService as never,
    (opts.withItems === false ? undefined : contextItemRepository) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    workflowDispatch as never,
    undefined,
  );
  return { handler, noteGenerationService, workflowDispatch };
}

const stop: TranscriptionCreatedPayload = {
  consultationId: CID,
  tenantId: TENANT,
  contextItemId: FT,
  transcriptionSource: 'streaming',
  timestamp: 't',
};

describe('ConsultationEventHandler — a session final the encounter re-finalisation owns', () => {
  it('encounter 2 stop on a STOPPED consultation: the auto-pipeline starts nothing (one run, not two)', async () => {
    const w = handlerWorld({ encounterSeq: 2, version: 2 });
    await w.handler.handleTranscriptionCreated(stop);

    expect(w.noteGenerationService.generate).not.toHaveBeenCalled();
    expect(w.noteGenerationService.resolveConfig).not.toHaveBeenCalled();
    expect(w.workflowDispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });

  it('the same encounter recorded again (FULL_TRANSCRIPT v2) is the re-finalisation’s too', async () => {
    const w = handlerWorld({ encounterSeq: 1, version: 2 });
    await w.handler.handleTranscriptionCreated(stop);
    expect(w.noteGenerationService.generate).not.toHaveBeenCalled();
  });

  it('encounter 1’s first transcript keeps the auto-pipeline (the first note)', async () => {
    const w = handlerWorld({ encounterSeq: 1, version: 1 });
    await w.handler.handleTranscriptionCreated(stop);
    expect(w.noteGenerationService.generate).toHaveBeenCalledWith(
      GenerationTrigger.TRANSCRIPTION_CREATED,
      expect.objectContaining({ consultationId: CID, contextItemId: FT }),
    );
  });

  it('without the context-item repository the auto-pipeline proceeds as before', async () => {
    const w = handlerWorld({ encounterSeq: 2, version: 2, withItems: false });
    await w.handler.handleTranscriptionCreated(stop);
    expect(w.noteGenerationService.generate).toHaveBeenCalledTimes(1);
  });
});

// ── 2. summary/async through the coordinator, and its job reaches a terminal state ────────────

/** Redis double: the watch scripts (SADD+EXPIRE / SMEMBERS+DEL) plus the job store's get/setex/publish. */
function redisDouble() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    eval: vi.fn(async (script: string, _n: number, key: string, member?: string) => {
      if (script.includes('SADD')) {
        const set = sets.get(key) ?? new Set<string>();
        set.add(String(member));
        sets.set(key, set);
        return 1;
      }
      if (script.includes('SMEMBERS')) {
        const members = [...(sets.get(key) ?? [])];
        sets.delete(key);
        return members;
      }
      return null;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    publish: vi.fn(async () => 1),
  };
}

function seamWorld(outcome: Awaited<ReturnType<EncounterRefinalizeService['onExplicitRequest']>>) {
  const redis = redisDouble();
  const jobs = new ConsultationJobService({} as never, redis as never, {} as never);
  const coordinator = { onExplicitRequest: vi.fn().mockResolvedValue(outcome) };
  const moduleRef = {
    get: vi.fn((token: unknown) => {
      if (token === EncounterRefinalizeService) return coordinator;
      if (token === IConsultationJobService) return jobs;
      throw new Error('not wired');
    }),
  };
  const harnessGateway = { start: vi.fn().mockResolvedValue({ status: 'started' }) };
  const service = new NoteGenerationService(
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, patientId: 'patient-1', metadata: null })) } as never,
    harnessGateway as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn(), run: vi.fn() } as never,
    undefined,
    moduleRef as never,
    undefined,
    redis as never,
  );
  return { service, coordinator, harnessGateway, redis, jobs };
}

const request = { consultationId: CID, tenantId: TENANT, userId: 'doctor-1' };

function lifecycle(processing: string, processingReason?: string, status = 'STOPPED'): LifecycleChangedPayload {
  return {
    consultationId: CID,
    tenantId: TENANT,
    timestamp: 't',
    event: {
      type: 'processing_changed',
      consultationId: CID,
      status,
      processing,
      ...(processingReason ? { processingReason } : {}),
      encounterSeq: 2,
      version: 4,
      at: 't',
      seq: 7,
    } as unknown as LifecycleChangedPayload['event'],
  };
}

describe('NoteGenerationService.generate(SUMMARY_REGENERATE) — the encounter re-finalisation hook', () => {
  it('governed re-finalisation: no harness-doc start; a REAL job id (not the run id) is returned and watched', async () => {
    const w = seamWorld({ kind: 'started', lane: 'governed', jobId: 'run-e2' });

    const decision = await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request);

    expect(w.coordinator.onExplicitRequest).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' }),
    );
    const minted = (w.coordinator.onExplicitRequest.mock.calls[0]![0] as { jobId: string }).jobId;
    expect(decision).toEqual({ generator: 'harness', harnessJobId: minted });
    expect(minted).toMatch(/^harness-doc-/);
    expect(w.harnessGateway.start).not.toHaveBeenCalled();
    expect([...(w.redis.sets.get(noteJobWatchKey(CID)) ?? [])]).toEqual([minted]);
  });

  it('coalesced onto a harness-doc run: that run’s job id (it completes it itself), nothing watched, nothing started', async () => {
    const w = seamWorld({ kind: 'coalesced', lane: 'harness-doc', jobId: 'harness-doc-stop' });

    expect(await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request)).toEqual({
      generator: 'harness',
      harnessJobId: 'harness-doc-stop',
    });
    expect(w.harnessGateway.start).not.toHaveBeenCalled();
    expect(w.redis.sets.has(noteJobWatchKey(CID))).toBe(false);
  });

  it('coalesced onto the governing run: the caller’s own job is watched', async () => {
    const w = seamWorld({ kind: 'coalesced', lane: 'governed', jobId: 'run-e2' });
    const decision = await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request);
    expect(decision.generator === 'harness' && decision.harnessJobId).toMatch(/^harness-doc-/);
    expect(w.redis.sets.get(noteJobWatchKey(CID))?.size).toBe(1);
  });

  it('a failed re-finalisation is a 503 carrying the reason code', async () => {
    const w = seamWorld({ kind: 'failed', lane: 'governed', reason: 'NOTE_REFINALIZE_FAILED' });

    const error = await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'NOTE_REFINALIZE_FAILED',
      message: 'The note could not be re-generated.',
    });
    expect(w.harnessGateway.start).not.toHaveBeenCalled();
  });

  it('not a re-finalisation (encounter 1): the usual harness-doc start', async () => {
    const w = seamWorld({ kind: 'not-refinalize', reason: 'first' });
    const decision = await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request);
    expect(w.harnessGateway.start).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ generator: 'harness' });
  });

  it('the auto-pipeline trigger never consults the coordinator (it listens to the stop itself)', async () => {
    const w = seamWorld({ kind: 'started', lane: 'governed', jobId: 'run-e2' });
    await w.service.generate(GenerationTrigger.TRANSCRIPTION_CREATED, request);
    expect(w.coordinator.onExplicitRequest).not.toHaveBeenCalled();
    expect(w.harnessGateway.start).toHaveBeenCalledTimes(1);
  });
});

describe('a watched note job reaches a terminal state', () => {
  async function registered(w: ReturnType<typeof seamWorld>): Promise<string> {
    const decision = await w.service.generate(GenerationTrigger.SUMMARY_REGENERATE, request);
    const jobId = decision.generator === 'harness' ? decision.harnessJobId : '';
    // What `POST :id/summary/async` does with the id it is handed.
    await w.jobs.registerHarnessNoteJob(jobId, CID, TENANT, 'doctor-1');
    return jobId;
  }

  it('the note lands (STOPPED + IDLE + NOTE_READY) → the polled job is COMPLETED, once', async () => {
    const w = seamWorld({ kind: 'started', lane: 'governed', jobId: 'run-e2' });
    const jobId = await registered(w);

    await w.service.onLifecycleChanged(lifecycle('SUMMARIZING'));
    expect((await w.jobs.getJobStatus(jobId))?.status).toBe('PENDING');

    await w.service.onLifecycleChanged(lifecycle('IDLE', 'NOTE_READY'));
    const settled = await w.jobs.getJobStatus(jobId);
    expect(settled).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(JSON.stringify(settled?.result)).not.toContain('E1');
    expect(w.redis.sets.has(noteJobWatchKey(CID))).toBe(false);
  });

  it('a written note that needs a human (AWAITING_REVIEW) also completes the job', async () => {
    const w = seamWorld({ kind: 'coalesced', lane: 'governed', jobId: null });
    const jobId = await registered(w);
    await w.service.onLifecycleChanged(lifecycle('AWAITING_REVIEW', 'NOTE_COVERAGE_GAPS:2'));
    expect((await w.jobs.getJobStatus(jobId))?.status).toBe('COMPLETED');
  });

  it('the run fails (processing FAILED) → the job is FAILED with the reason code', async () => {
    const w = seamWorld({ kind: 'started', lane: 'governed', jobId: 'run-e2' });
    const jobId = await registered(w);
    await w.service.onLifecycleChanged(lifecycle('FAILED', 'GOVERNED_RUN_FAILED'));
    expect(await w.jobs.getJobStatus(jobId)).toMatchObject({ status: 'FAILED', error: 'GOVERNED_RUN_FAILED' });
  });

  it('IDLE without NOTE_READY (a stop restoring processing) is not a written note', async () => {
    const w = seamWorld({ kind: 'started', lane: 'governed', jobId: 'run-e2' });
    const jobId = await registered(w);
    await w.service.onLifecycleChanged(lifecycle('IDLE'));
    expect((await w.jobs.getJobStatus(jobId))?.status).toBe('PENDING');
    expect(w.redis.sets.get(noteJobWatchKey(CID))?.has(jobId)).toBe(true);
  });
});

// ── 4. the note-inputs guidance ───────────────────────────────────────────────────────────────

describe('note-inputs guidance — every encounter’s safety facts are carried', () => {
  it('names allergies, medications, abnormal results, orders and follow-up from EVERY encounter', () => {
    expect(NOTE_INPUTS_GUIDANCE).toContain(
      'Every encounter belongs in the note: carry every allergy (with its reaction), current medication (with its dose), abnormal vital or result, order and follow-up from EVERY encounter into the note, each with its label; a fact from an earlier encounter stays unless a later encounter changes it.',
    );
    expect(NOTE_INPUTS_GUIDANCE).not.toContain('Every encounter belongs in the note. ');
    expect(NOTE_INPUTS_GUIDANCE).toContain('the later encounter wins');
  });
});
