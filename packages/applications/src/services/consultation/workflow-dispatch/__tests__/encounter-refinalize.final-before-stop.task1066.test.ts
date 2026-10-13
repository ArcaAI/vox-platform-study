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

function build(consultation: Row, item: ReturnType<typeof transcript> | null = transcript()) {
  const gate = {
    setProcessing: vi.fn(async (_id: string, processing: string) => {
      consultation.processing = processing;
    }),
  };
  const dispatch = { supersedeGoverningRun: vi.fn().mockResolvedValue({ superseded: true, runId: 'run-e2', supersededRunId: 'run-open' }) };
  const harnessGateway = { start: vi.fn() };
  const service = new EncounterRefinalizeService(
    { findByIdOrNull: vi.fn(async () => ({ ...consultation })) } as never,
    {
      findByIdOrNull: vi.fn(async (id: string) => (item && id === item.id ? item : null)),
      findFullTranscript: vi.fn(async () => item),
      findByType: vi.fn(async () => []),
    } as never,
    harnessGateway as never,
    { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() } as never,
    undefined,
    dispatch as never,
    undefined,
    gate as never,
  );
  return { service, gate, dispatch, harnessGateway, consultation };
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
