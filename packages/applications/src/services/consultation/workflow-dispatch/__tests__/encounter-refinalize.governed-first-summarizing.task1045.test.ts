/**
 * TASK-1045 e2e (E2E-36) — the governed encounter-1 note is written by the governing run AFTER the
 * stop's session final, and nothing reported it: processing read IDLE for the ~2.5 min the run
 * spent on the fact ledger and the note (live e2e 2026-10-06, consultation `01a10dd1-532a-…`:
 * `transcript_final` STOPPED/IDLE at 20:47:16, the next change `processing_changed` IDLE +
 * NOTE_READY at 20:49:45). A client reading `processing` saw "nothing running" and no note.
 *
 * The session final of encounter 1 on a governed consultation whose governing run is still RUNNING
 * now marks SUMMARIZING; the harness handlers settle it (IDLE + NOTE_READY, AWAITING_REVIEW, or
 * FAILED) exactly as they do for a re-finalisation.
 */
import { describe, expect, it, vi } from 'vitest';

import { EncounterRefinalizeService } from '../encounter-refinalize.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = '01a10d5e-f898-7346-b5ec-31d5a7dfad38';
const FT = '01a10d5f-bc8f-7b82-a235-410b7cdb14f4';
const GOVERNED_META = {
  governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-open', workflowDefinitionSlug: 'arcaai-bren-consultation' },
};

type Row = Record<string, unknown> & { metadata: Record<string, unknown> | null };

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: CID,
    tenantId: TENANT,
    status: 'STOPPED',
    processing: 'IDLE',
    processingReason: null,
    currentEncounterSeq: 2,
    segmentSeqHead: 21,
    doctorId: 'doctor-1',
    departmentId: null,
    patientId: 'patient-1',
    metadata: GOVERNED_META,
    ...overrides,
  };
}

function transcript(version: number, segmentCount: number) {
  return {
    id: FT,
    consultationId: CID,
    tenantId: TENANT,
    type: 'FULL_TRANSCRIPT',
    currentVersionNumber: version,
    content: '…',
    metaData: { segmentCount },
  };
}

function build(opts: { consultation: Row; item: ReturnType<typeof transcript> | null }) {
  let item = opts.item;
  const consultation = opts.consultation;
  const store = new Map<string, string>();
  const redis = {
    eval: vi.fn(async (script: string, _n: number, key: string, value: string) => {
      if (script.includes("'NX'") && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => void store.delete(key)),
  };
  const contextItems = {
    findByIdOrNull: vi.fn(async (id: string) => (item && id === item.id ? item : null)),
    findFullTranscript: vi.fn(async () => item),
    findByType: vi.fn(async () => []),
  };
  const harnessGateway = { start: vi.fn().mockResolvedValue({ status: 'started' }) };
  const dispatch = { supersedeGoverningRun: vi.fn().mockResolvedValue({ superseded: true, runId: 'run-e2', supersededRunId: 'run-open' }) };
  const gate = {
    setProcessing: vi.fn(async (_id: string, processing: string) => {
      consultation.processing = processing;
    }),
  };
  const composer = { composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: { consultationId: CID, mode: 'final', planId: 'plan-1' } }) };
  const service = new EncounterRefinalizeService(
    { findByIdOrNull: vi.fn(async () => ({ ...consultation })) } as never,
    contextItems as never,
    harnessGateway as never,
    { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() } as never,
    composer as never,
    dispatch as never,
    redis as never,
    gate as never,
  );
  return { service, harnessGateway, dispatch, gate, setItem: (next: ReturnType<typeof transcript>) => (item = next) };
}

const stopEvent = { consultationId: CID, tenantId: TENANT, contextItemId: FT, transcriptionSource: 'streaming' as const, timestamp: 't' };

describe('governed encounter 1 — the session final reports the note the governing run is about to write', () => {
  it('marks SUMMARIZING while the governing run is RUNNING, and starts nothing', async () => {
    const { service, gate, dispatch, harnessGateway } = build({
      consultation: row({ currentEncounterSeq: 1, segmentSeqHead: 11 }),
      item: transcript(1, 11),
    });
    const outcome = await service.onTranscriptionCreated(stopEvent as never);
    expect(outcome).toEqual({ kind: 'not-refinalize', reason: 'first' });
    expect(gate.setProcessing).toHaveBeenCalledWith(CID, 'SUMMARIZING');
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(harnessGateway.start).not.toHaveBeenCalled();
  });

  it('leaves processing alone when the governing run already ended, or the consultation is not governed', async () => {
    const ended = build({
      consultation: row({
        currentEncounterSeq: 1,
        segmentSeqHead: 11,
        metadata: { governingEngine: { ...GOVERNED_META.governingEngine, runStatus: 'FAILED' } },
      }),
      item: transcript(1, 11),
    });
    await ended.service.onTranscriptionCreated(stopEvent as never);
    expect(ended.gate.setProcessing).not.toHaveBeenCalled();

    const ungoverned = build({ consultation: row({ currentEncounterSeq: 1, segmentSeqHead: 11, metadata: null }), item: transcript(1, 11) });
    await ungoverned.service.onTranscriptionCreated(stopEvent as never);
    expect(ungoverned.gate.setProcessing).not.toHaveBeenCalled();
  });

  it('never overwrites an attachment in progress', async () => {
    const { service, gate } = build({
      consultation: row({ currentEncounterSeq: 1, segmentSeqHead: 11, processing: 'PROCESSING_ATTACHMENT' }),
      item: transcript(1, 11),
    });
    await service.onTranscriptionCreated(stopEvent as never);
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });
});
