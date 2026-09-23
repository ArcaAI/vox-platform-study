/**
 * TASK-1001 wave 4 (OD-14; owner decisions D-3/D-4, 2026-09-23) — a RESUMED recording re-finalises
 * the note.
 *
 * On `hope-v2-dev` the final note (`summary/latest`) covered only the FIRST recording of a
 * consultation that was stopped and resumed three times: the first draft's `HarnessDocWorkflow` was
 * parked at the clinician gate, so every later start answered `already_running`. When a resumed
 * session's aggregate transcript lands on a consultation that already holds an UNSIGNED harness
 * draft, the handler now asks the seam to SUPERSEDE that run with the whole visit's transcript. A
 * SIGNED note is never replaced (D-4). The first session's transcript keeps today's path exactly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsultationEventHandler } from '../consultation-event.handler';
import { GenerationTrigger } from '../../note-generation';
import { DEFAULT_PIPELINE_CONFIG, type TranscriptionCreatedPayload } from '../consultation.events';

const CID = 'consultation-resume';
const at = (minute: number) => new Date(`2026-09-23T08:${String(minute).padStart(2, '0')}:00.000Z`);

const aggregate = (id: string, content: string, minute: number) => ({
  id,
  content,
  createdAt: at(minute),
  metaData: { subType: 'STT_AGGREGATE', sttSessionId: `stt-${id}` },
});
const segment = { id: 'seg-1', content: 'one utterance', createdAt: at(1), metaData: { subType: 'TRANSCRIPT_SEGMENT' }, createdBy: 'doctor-1' };
const draft = { id: 'draft-1', createdAt: at(4), metaData: { subType: 'HARNESS_DRAFT' } };

const payload = (contextItemId: string): TranscriptionCreatedPayload => ({
  consultationId: CID,
  tenantId: 'tenant-1',
  userId: 'doctor-1',
  contextItemId,
  correlationId: 'corr-1',
  timestamp: new Date().toISOString(),
  transcriptionSource: 'streaming',
});

describe('TASK-1001 wave 4 — a resumed recording re-finalises the note', () => {
  let consultation: { id: string; tenantId: string; patientId: string; metadata: unknown; status: string };
  let transcripts: unknown[];
  let rawSummaries: unknown[];
  let approvedVersions: unknown[];
  let generate: ReturnType<typeof vi.fn>;
  let handler: ConsultationEventHandler;

  beforeEach(() => {
    consultation = { id: CID, tenantId: 'tenant-1', patientId: 'p-1', metadata: null, status: 'DRAINING' };
    transcripts = [aggregate('agg-1', 'first recording', 2), segment];
    rawSummaries = [];
    approvedVersions = [];
    generate = vi.fn().mockResolvedValue({ generator: 'harness', harnessJobId: 'harness-doc-x' });

    const consultationRepository = { findById: vi.fn(async () => consultation) };
    const noteGenerationService = {
      generate,
      resolveConfig: vi.fn(async () => ({ ...DEFAULT_PIPELINE_CONFIG })),
    };
    const contextItemRepository = {
      findById: vi.fn(async (id: string) => (transcripts as Array<{ id: string }>).find((t) => t.id === id) ?? null),
      findTranscripts: vi.fn(async () => transcripts),
      findByType: vi.fn(async () => rawSummaries),
    };
    const versions = { getVersionsByChangeReason: vi.fn(async () => approvedVersions) };
    const cls = { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() };

    handler = new ConsultationEventHandler(
      consultationRepository as never,
      { emit: vi.fn() } as never,
      cls as never,
      noteGenerationService as never,
      contextItemRepository as never,
      undefined, // configResolver
      undefined, // dnaReportRepository
      undefined, // secretsService
      versions as never,
    );
  });

  it('the FIRST session keeps today’s path: no supersede', async () => {
    await handler.handleTranscriptionCreated(payload('agg-1'));

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][1]).not.toHaveProperty('supersede');
  });

  it('a resumed session on an UNSIGNED draft supersedes it with the whole visit’s transcript, in order', async () => {
    transcripts = [aggregate('agg-2', 'after the resume', 20), segment, aggregate('agg-1', 'first recording', 2)];
    rawSummaries = [draft];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      GenerationTrigger.TRANSCRIPTION_CREATED,
      expect.objectContaining({ consultationId: CID, contextItemId: 'agg-2', supersede: true, transcriptText: 'first recording\n\nafter the resume' }),
    );
  });

  it('re-finalises even when auto-summary is off — the harness already owns this note', async () => {
    transcripts = [aggregate('agg-1', 'first recording', 2), aggregate('agg-2', 'after the resume', 20)];
    rawSummaries = [draft];
    consultation.metadata = { pipelineConfig: { autoSummaryEnabled: false } };

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).toHaveBeenCalledWith(GenerationTrigger.TRANSCRIPTION_CREATED, expect.objectContaining({ supersede: true }));
  });

  it('never replaces a SIGNED note (D-4) — and does not start a second run beside it either', async () => {
    transcripts = [aggregate('agg-1', 'first recording', 2), aggregate('agg-2', 'after the resume', 20)];
    rawSummaries = [draft];
    approvedVersions = [{ id: 'v-signed', changeReason: 'approved' }];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).not.toHaveBeenCalled();
  });

  it('a resumed session with no draft yet keeps today’s path (the first finalize is still running)', async () => {
    transcripts = [aggregate('agg-1', 'first recording', 2), aggregate('agg-2', 'after the resume', 20)];

    await handler.handleTranscriptionCreated(payload('agg-2'));

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][1]).not.toHaveProperty('supersede');
  });
});
