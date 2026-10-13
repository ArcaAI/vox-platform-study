/**
 * The governed encounter-1 session final can land BEFORE the stop: the client closes its STT
 * session, the final transcript is ingested while the consultation is still RECORDING, and only
 * then does the stop request arrive (cluster 2026-10-13, consultation `01a13368-…`:
 * `POST internal/stt/transcripts` 04:00:32.054–.181, `POST :id/stop` 04:00:32.189–.264). The
 * session final was classified `not-stopped` and marked nothing; the stop found no live session,
 * restored IDLE, and processing read STOPPED/IDLE for the 100 s the governing run spent writing the
 * note — never SUMMARIZING.
 *
 * The stop's own announcement (`EncounterStopped`) now reports the note the governing run is about
 * to write, under the same rule the session final applies.
 */
import { describe, expect, it, vi } from 'vitest';

import { EncounterRefinalizeService } from '../encounter-refinalize.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = '01a13368-3399-7eaf-b5d3-0912b911ecc5';
const FT = '01a1336b-4b6e-745e-b488-a018fc2ab4c3';
const GOVERNED_META = {
  governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-open', workflowDefinitionSlug: 'arcaai-bren-consultation' },
};

type Row = Record<string, unknown> & { metadata: Record<string, unknown> | null };

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: CID,
    tenantId: TENANT,
    status: 'RECORDING',
    processing: 'IDLE',
    processingReason: null,
    currentEncounterSeq: 1,
    segmentSeqHead: 11,
    metadata: GOVERNED_META,
    ...overrides,
  };
}

function transcript(version = 1, segmentCount = 11) {
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

function build(consultation: Row, item: ReturnType<typeof transcript> | null = transcript(), opts: { redis?: boolean } = {}) {
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
  const gate = {
    setProcessing: vi.fn(async (_id: string, processing: string) => {
      consultation.processing = processing;
    }),
  };
  // The governing-run marker compare-and-set: one supersede per trigger id, a repeat is a duplicate.
  const triggers = new Set<string>();
  const dispatch = {
    supersedeGoverningRun: vi.fn(async ({ triggerId }: { triggerId: string }) => {
      if (triggers.has(triggerId)) return { superseded: false, skippedReason: 'duplicate', runId: 'run-e2' };
      triggers.add(triggerId);
      return { superseded: true, runId: 'run-e2', supersededRunId: 'run-open' };
    }),
  };
  const harnessGateway = { start: vi.fn() };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() };
  const service = new EncounterRefinalizeService(
    { findByIdOrNull: vi.fn(async () => ({ ...consultation })) } as never,
    {
      findByIdOrNull: vi.fn(async (id: string) => (item && id === item.id ? item : null)),
      findFullTranscript: vi.fn(async () => item),
      findByType: vi.fn(async () => []),
    } as never,
    harnessGateway as never,
    cls as never,
    undefined,
    dispatch as never,
    opts.redis ? (redis as never) : undefined,
    gate as never,
  );
  return { service, gate, dispatch, harnessGateway, consultation, cls, store };
}

const finalEvent = { consultationId: CID, tenantId: TENANT, contextItemId: FT, transcriptionSource: 'streaming' as const, timestamp: 't' };
const stoppedEvent = { consultationId: CID, tenantId: TENANT, encounterSeq: 1, timestamp: 't' };

describe('governed encounter 1 — the session final lands before the stop', () => {
  it('the stop’s EncounterStopped marks SUMMARIZING that the early session final could not', async () => {
    const { service, gate, consultation, dispatch, harnessGateway } = build(row());

    // The final arrives while the consultation is still RECORDING: not this stop's to report yet.
    expect(await service.onTranscriptionCreated(finalEvent as never)).toEqual({ kind: 'not-refinalize', reason: 'not-stopped' });
    expect(gate.setProcessing).not.toHaveBeenCalled();

    // The stop lands: STOPPED, no live session left, processing restored to IDLE.
    consultation.status = 'STOPPED';
    await service.onEncounterStopped(stoppedEvent as never);

    expect(gate.setProcessing).toHaveBeenCalledWith(CID, 'SUMMARIZING');
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(harnessGateway.start).not.toHaveBeenCalled();
  });

  it('writes nothing when the session final already reported the note (SUMMARIZING) or the note is out', async () => {
    for (const processing of ['SUMMARIZING', 'AWAITING_REVIEW', 'FAILED', 'PROCESSING_ATTACHMENT']) {
      const { service, gate } = build(row({ status: 'STOPPED', processing }));
      await service.onEncounterStopped(stoppedEvent as never);
      expect(gate.setProcessing).not.toHaveBeenCalled();
    }
  });

  it('writes nothing for an ungoverned consultation, an ended governing run, or no transcript', async () => {
    const ungoverned = build(row({ status: 'STOPPED', metadata: null }));
    await ungoverned.service.onEncounterStopped(stoppedEvent as never);
    expect(ungoverned.gate.setProcessing).not.toHaveBeenCalled();

    const ended = build(row({ status: 'STOPPED', metadata: { governingEngine: { ...GOVERNED_META.governingEngine, runStatus: 'FAILED' } } }));
    await ended.service.onEncounterStopped(stoppedEvent as never);
    expect(ended.gate.setProcessing).not.toHaveBeenCalled();

    const silent = build(row({ status: 'STOPPED' }), null);
    await silent.service.onEncounterStopped(stoppedEvent as never);
    expect(silent.gate.setProcessing).not.toHaveBeenCalled();
  });

  it('starts nothing on a later encounter — the re-finalisation is the session final’s', async () => {
    const { service, gate, dispatch, harnessGateway } = build(row({ status: 'STOPPED', currentEncounterSeq: 2 }), transcript(2, 21));
    await service.onEncounterStopped({ ...stoppedEvent, encounterSeq: 2 } as never);
    expect(gate.setProcessing).not.toHaveBeenCalled();
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(harnessGateway.start).not.toHaveBeenCalled();
  });

  it('ignores an event for another tenant', async () => {
    const { service, gate } = build(row({ status: 'STOPPED' }));
    await service.onEncounterStopped({ ...stoppedEvent, tenantId: '50000000-0000-0000-0000-000000000009' } as never);
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });
});

describe('the stop’s worker session', () => {
  it('runs the EncounterStopped listener under its own worker-session label', async () => {
    const { service, cls } = build(row({ status: 'STOPPED' }));
    await service.onEncounterStopped(stoppedEvent as never);
    expect(cls.set).toHaveBeenCalledWith('user', expect.objectContaining({ email: 'encounter-stopped-event@system.local' }));
  });
});

describe('governed later encounter — the session final lands before the stop', () => {
  const enc2 = () => row({ currentEncounterSeq: 2, segmentSeqHead: 21 });
  const stopped2 = { ...stoppedEvent, encounterSeq: 2 };

  it('the stop supersedes the governing run that the early session final could not, and reports SUMMARIZING', async () => {
    const { service, gate, dispatch, consultation } = build(enc2(), transcript(2, 21), { redis: true });

    expect(await service.onTranscriptionCreated(finalEvent as never)).toEqual({ kind: 'not-refinalize', reason: 'not-stopped' });
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();

    consultation.status = 'STOPPED';
    await service.onEncounterStopped(stopped2 as never);

    expect(dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(dispatch.supersedeGoverningRun).toHaveBeenCalledWith(expect.objectContaining({ triggerId: `refinalize:${FT}:v2` }));
    expect(gate.setProcessing).toHaveBeenCalledWith(CID, 'SUMMARIZING');
  });

  it('a second stop with no new transcript since does nothing', async () => {
    const { service, gate, dispatch, consultation } = build(enc2(), transcript(2, 21), { redis: true });
    await service.onTranscriptionCreated(finalEvent as never);
    consultation.status = 'STOPPED';
    await service.onEncounterStopped(stopped2 as never);
    gate.setProcessing.mockClear();
    dispatch.supersedeGoverningRun.mockClear();

    await service.onEncounterStopped(stopped2 as never);

    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });

  it('does nothing when the session final landed after the stop (it re-finalised itself)', async () => {
    const { service, gate, dispatch } = build(row({ status: 'STOPPED', currentEncounterSeq: 2, segmentSeqHead: 21 }), transcript(2, 21), {
      redis: true,
    });
    expect(await service.onTranscriptionCreated(finalEvent as never)).toMatchObject({ kind: 'started', lane: 'governed' });
    gate.setProcessing.mockClear();
    dispatch.supersedeGoverningRun.mockClear();

    await service.onEncounterStopped(stopped2 as never);

    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });

  it('a stop on a new encounter with no new transcript (the last re-finalised state, or the open-time note) does nothing', async () => {
    const { service, gate, dispatch } = build(row({ status: 'STOPPED', currentEncounterSeq: 3, segmentSeqHead: 21 }), transcript(2, 21), {
      redis: true,
    });

    await service.onEncounterStopped({ ...stoppedEvent, encounterSeq: 3 } as never);

    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });

  it('an early session final for an OLDER transcript version does not re-finalise the current one at the stop', async () => {
    const { service, dispatch, consultation } = build(enc2(), transcript(2, 21), { redis: true });
    await service.onTranscriptionCreated(finalEvent as never);
    // A later session final (same encounter) folded more speech in and re-finalised itself.
    consultation.status = 'STOPPED';
    const later = build(consultation, transcript(3, 25), { redis: true });
    await later.service.onEncounterStopped(stopped2 as never);
    expect(later.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });

  it('an explicit note request that re-finalised the state after the stop leaves the stop nothing to do (coalesced)', async () => {
    const { service, gate, dispatch, consultation } = build(enc2(), transcript(2, 21), { redis: true });
    await service.onTranscriptionCreated(finalEvent as never);
    consultation.status = 'STOPPED';
    expect(await service.onExplicitRequest({ consultationId: CID, tenantId: TENANT, jobId: 'job-1' })).toMatchObject({ kind: 'started' });
    gate.setProcessing.mockClear();
    dispatch.supersedeGoverningRun.mockClear();

    await service.onEncounterStopped(stopped2 as never);

    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    expect(gate.setProcessing).not.toHaveBeenCalled();
  });

  it('an ungoverned consultation is left to the auto-pipeline: the stop starts nothing', async () => {
    const { service, harnessGateway, dispatch, consultation } = build(
      row({ currentEncounterSeq: 2, segmentSeqHead: 21, metadata: null }),
      transcript(2, 21),
      {
        redis: true,
      },
    );
    await service.onTranscriptionCreated(finalEvent as never);
    consultation.status = 'STOPPED';
    await service.onEncounterStopped(stopped2 as never);
    expect(harnessGateway.start).not.toHaveBeenCalled();
    expect(dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });
});
