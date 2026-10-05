/**
 * TASK-1022 L-RESUME (owner decision 2026-09-30) — a GOVERNED consultation that records again
 * after a stop is re-finalised by its GOVERNING graph over the whole visit, NOT by the default
 * `harness-doc` engine.
 *
 * Before: `resumedSessionPlan` → `noteGenerationService.generate(…, supersede: true)` started
 * `HarnessDocWorkflow` for EVERY consultation, so a governed note was replaced by the default
 * engine's shape (replay run3: bold numbered headings, citation markers). Now a governed
 * consultation asks the dispatcher to supersede its governing run; a non-governed one keeps the
 * TASK-1001 path exactly (pinned by `consultation-event.handler.resume.task1001.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsultationEventHandler } from '../consultation-event.handler';
import { DEFAULT_PIPELINE_CONFIG, type TranscriptionCreatedPayload } from '../consultation.events';

const CID = 'consultation-governed-resume';
const at = (minute: number) => new Date(`2026-09-30T08:${String(minute).padStart(2, '0')}:00.000Z`);

const aggregate = (id: string, content: string, minute: number) => ({
  id,
  content,
  createdAt: at(minute),
  metaData: { subType: 'STT_AGGREGATE', sttSessionId: `stt-${id}` },
});
const draft = { id: 'draft-1', createdAt: at(4), metaData: { subType: 'HARNESS_DRAFT' } };
const structured = (id: string, kindKey: string, payload: unknown, minute: number) => ({
  id,
  kindKey,
  content: JSON.stringify(payload),
  createdAt: at(minute),
  metaData: {},
});

const GOVERNED = {
  governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-old', workflowDefinitionSlug: 'arcaai-consultation-v1' },
};

const payload = (contextItemId: string): TranscriptionCreatedPayload => ({
  consultationId: CID,
  tenantId: 'tenant-1',
  userId: 'doctor-1',
  contextItemId,
  correlationId: 'corr-1',
  timestamp: new Date().toISOString(),
  transcriptionSource: 'streaming',
});

describe('TASK-1022 L-RESUME — a governed resumed recording is re-finalised by the governing graph', () => {
  let consultation: { id: string; tenantId: string; patientId: string; doctorId: string; metadata: unknown; status: string };
  let transcripts: unknown[];
  let rawSummaries: unknown[];
  let structuredItems: unknown[];
  let approvedVersions: unknown[];
  let generate: ReturnType<typeof vi.fn>;
  let supersedeGoverningRun: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let handler: ConsultationEventHandler;

  function build(dispatch: unknown) {
    const consultationRepository = { findById: vi.fn(async () => consultation) };
    // The real seam stands auto-summary DOWN for a governed consultation (substrate exclusivity).
    const noteGenerationService = {
      generate,
      resolveConfig: vi.fn(async () => ({
        ...DEFAULT_PIPELINE_CONFIG,
        autoSummaryEnabled: !(consultation.metadata as { governingEngine?: unknown } | null)?.governingEngine,
      })),
    };
    const contextItemRepository = {
      findById: vi.fn(async (id: string) => (transcripts as Array<{ id: string }>).find((t) => t.id === id) ?? null),
      findTranscripts: vi.fn(async () => transcripts),
      findByType: vi.fn(async (_cid: string, type: string) => (type === 'STRUCTURED' ? structuredItems : rawSummaries)),
    };
    const versions = { getVersionsByChangeReason: vi.fn(async () => approvedVersions) };
    const cls = { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() };
    emit = vi.fn();
    return new ConsultationEventHandler(
      consultationRepository as never,
      { emit } as never,
      cls as never,
      noteGenerationService as never,
      contextItemRepository as never,
      undefined, // configResolver
      undefined, // dnaReportRepository
      undefined, // secretsService — env-mode dev: `content` is already plaintext
      versions as never,
      dispatch as never,
    );
  }

  beforeEach(() => {
    consultation = { id: CID, tenantId: 'tenant-1', patientId: 'p-1', doctorId: 'doctor-1', metadata: GOVERNED, status: 'STOPPED' };
    transcripts = [aggregate('agg-1', 'first recording', 2), aggregate('agg-2', 'after the resume', 20)];
    rawSummaries = [draft];
    structuredItems = [];
    approvedVersions = [];
    generate = vi.fn().mockResolvedValue({ generator: 'harness', harnessJobId: 'harness-doc-x' });
    supersedeGoverningRun = vi.fn().mockResolvedValue({ superseded: true, runId: 'run-new', supersededRunId: 'run-old' });
    handler = build({ supersedeGoverningRun });
  });

  it('supersedes the GOVERNING run and never calls the default engine', async () => {
    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).not.toHaveBeenCalled();
    expect(supersedeGoverningRun).toHaveBeenCalledOnce();
    expect(supersedeGoverningRun).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: CID, tenantId: 'tenant-1', triggerId: 'agg-2', userId: 'doctor-1' }),
    );
  });

  it('carries the context the client authored (newest item per kind) to the fresh run', async () => {
    structuredItems = [
      structured('s-1', 'vitals', { heartRate: 80 }, 1),
      structured('s-2', 'previous_case_notes', { notes: [{ text: 'old' }] }, 1),
      structured('s-3', 'vitals', { heartRate: 92 }, 25),
      { id: 's-4', kindKey: null, content: '{"ignored":true}', createdAt: at(1), metaData: {} },
    ];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(supersedeGoverningRun.mock.calls[0][0].authoredContext).toEqual({
      vitals: { heartRate: 92 },
      previous_case_notes: { notes: [{ text: 'old' }] },
    });
  });

  it('re-finalises even before the first governed note exists — the governing run owns the note', async () => {
    rawSummaries = [];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(supersedeGoverningRun).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it('never re-finalises a SIGNED note — neither engine is asked', async () => {
    approvedVersions = [{ id: 'v-signed', changeReason: 'approved' }];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(supersedeGoverningRun).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('never re-finalises a consultation whose status is APPROVED / CLOSED_COMPLETE', async () => {
    for (const status of ['APPROVED', 'CLOSED_COMPLETE']) {
      consultation.status = status;
      await handler.handleTranscriptionCreated(payload('agg-2'));
    }

    expect(supersedeGoverningRun).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('a STALE transcript (not the newest recording) supersedes nothing — the newer one will', async () => {
    transcripts = [aggregate('agg-1', 'first', 2), aggregate('agg-2', 'second', 20), aggregate('agg-3', 'third', 40)];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(supersedeGoverningRun).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('the FIRST recording of a governed consultation still starts nothing (the governing run is waiting on it)', async () => {
    transcripts = [aggregate('agg-1', 'first recording', 2)];
    rawSummaries = [];

    await handler.handleTranscriptionCreated(payload('agg-1'));

    expect(supersedeGoverningRun).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('with no dispatcher wired it reports the failure and still never falls back to the default engine', async () => {
    handler = build(undefined);

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.objectContaining({ consultationId: CID, failedStep: 'summary' }));
  });

  it('a supersede that did not happen is reported, never a silent success', async () => {
    supersedeGoverningRun.mockResolvedValue({
      superseded: false,
      runId: 'run-old',
      supersededRunId: null,
      skippedReason: 'failed',
      reason: 'harness down',
    });

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.objectContaining({ consultationId: CID, failedStep: 'summary' }));
  });

  it('NON-governed consultations keep today’s default-engine supersede exactly', async () => {
    consultation.metadata = null;

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(supersedeGoverningRun).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersede: true, transcriptText: 'first recording\n\nafter the resume' }),
    );
  });
});
