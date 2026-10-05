/**
 * TASK-1045 e2e (E2E-10) — an explicit `summary/async` that arrives before the stop's session final
 * has folded the new speech into FULL_TRANSCRIPT never generates the note itself.
 *
 * Live e2e 2026-10-05, ArcaAI (governed by `arcaai-bren-consultation`), consultation `01a10d5e-…`:
 *
 *  - encounter 1: `stop` answered at 18:42:20.361 and ALaaS posted `summary/async` at once; the
 *    FULL_TRANSCRIPT item was created at 18:42:20.431. The request found no transcript, read as
 *    "not a re-finalisation", and started the DEFAULT engine (`harness-doc`, SUMMARY_REGENERATE)
 *    beside the governing run — two note writers on a governed consultation.
 *  - encounter 2: `summary/async` at 18:55:10.737 read FULL_TRANSCRIPT at v1 (11 of 21 segments),
 *    claimed state v1 and superseded the governing run; the session final then wrote v2 and the
 *    stop path superseded it AGAIN (`…:v1` then `…:v2`) — two governed runs for one stop.
 *
 * The consultation's `segmentSeqHead` counts every ingested segment and the FULL_TRANSCRIPT records
 * how many it was built from (`metaData.segmentCount`): while the head is ahead, the session final
 * is still coming and the stop path generates. The explicit request coalesces onto it (its job is
 * watched and settles when the note lands).
 */
import { describe, expect, it, vi } from 'vitest';

import { EncounterRefinalizeService } from '../encounter-refinalize.service';
import { transcriptFinalPending } from '../encounter-refinalize';

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

const explicit = { consultationId: CID, tenantId: TENANT, userId: 'doctor-1', jobId: 'harness-doc-explicit' };
const stopEvent = { consultationId: CID, tenantId: TENANT, contextItemId: FT, transcriptionSource: 'streaming' as const, timestamp: 't' };

describe('transcriptFinalPending', () => {
  it('ahead of the transcript (or no transcript yet, with speech) ⇒ pending', () => {
    expect(transcriptFinalPending({ segmentSeqHead: 21 }, { metaData: { segmentCount: 11 } })).toBe(true);
    expect(transcriptFinalPending({ segmentSeqHead: 11 }, null)).toBe(true);
  });

  it('folded, no speech, or a transcript that records no count ⇒ not pending', () => {
    expect(transcriptFinalPending({ segmentSeqHead: 21 }, { metaData: { segmentCount: 21 } })).toBe(false);
    expect(transcriptFinalPending({ segmentSeqHead: 0 }, null)).toBe(false);
    expect(transcriptFinalPending({ segmentSeqHead: 21 }, { metaData: null })).toBe(false);
    expect(transcriptFinalPending({}, { metaData: { segmentCount: 1 } })).toBe(false);
  });
});

describe('summary/async before the session final (encounter 2) — one governed run per stop', () => {
  it('coalesces instead of superseding on the stale state; the session final then supersedes ONCE', async () => {
    const h = build({ consultation: row(), item: transcript(1, 11) });

    const early = await h.service.onExplicitRequest(explicit);

    expect(early).toEqual({ kind: 'coalesced', lane: 'governed', jobId: null });
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(h.gate.setProcessing).not.toHaveBeenCalled();

    h.setItem(transcript(2, 21));
    const stop = await h.service.onTranscriptionCreated(stopEvent);

    expect(stop).toMatchObject({ kind: 'started', lane: 'governed' });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(h.dispatch.supersedeGoverningRun.mock.calls[0][0].triggerId).toBe(`refinalize:${FT}:v2`);
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
  });

  it('non-governed: the same race starts ONE harness-doc run, from the stop', async () => {
    const h = build({ consultation: row({ metadata: null }), item: transcript(1, 11) });

    expect(await h.service.onExplicitRequest(explicit)).toEqual({ kind: 'coalesced', lane: 'harness-doc', jobId: null });
    h.setItem(transcript(2, 21));
    await h.service.onTranscriptionCreated(stopEvent);

    expect(h.harnessGateway.start).toHaveBeenCalledTimes(1);
  });

  it('after the fold, summary/async still joins the stop’s claim (unchanged)', async () => {
    const h = build({ consultation: row(), item: transcript(2, 21) });

    await h.service.onTranscriptionCreated(stopEvent);
    const late = await h.service.onExplicitRequest(explicit);

    expect(late.kind).toBe('coalesced');
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
  });
});

describe('summary/async before the first session final (encounter 1, governed) — never the default engine', () => {
  it('no FULL_TRANSCRIPT yet: joins the governing run (not-refinalize would start harness-doc)', async () => {
    const h = build({ consultation: row({ currentEncounterSeq: 1, segmentSeqHead: 11 }), item: null });

    const outcome = await h.service.onExplicitRequest(explicit);

    expect(outcome).toEqual({ kind: 'coalesced', lane: 'governed', jobId: null });
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });

  it('non-governed encounter 1 with no transcript yet: coalesced onto the auto-pipeline (no stale start)', async () => {
    const h = build({ consultation: row({ currentEncounterSeq: 1, segmentSeqHead: 11, metadata: null }), item: null });

    expect(await h.service.onExplicitRequest(explicit)).toEqual({ kind: 'coalesced', lane: 'harness-doc', jobId: null });
    expect(h.harnessGateway.start).not.toHaveBeenCalled();
  });
});
