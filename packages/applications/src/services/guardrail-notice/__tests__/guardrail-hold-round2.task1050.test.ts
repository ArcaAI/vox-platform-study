/**
 * TASK-1050 W2e round 2 —
 *  - a guardrail hold is not bypassable: `start` (and its `recording/start` alias, which routes
 *    through it) on a consultation held with GUARDRAIL_HOLD / EGRESS_REDACTION_UNAVAILABLE is
 *    409 `GUARDRAIL_HOLD`;
 *  - every consultation context reader that feeds an LLM applies the exclusion (WITHHELD always,
 *    BLOCKED once its hold was resolved as item_excluded): the fact ledger (and the encounter recap
 *    built from it), the chain summary, and the endpoint service.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType } from '@arcaai/domains';
import { ConsultationLifecycleService } from '../../consultation/lifecycle/consultation-lifecycle.service';
import { FactLedgerService } from '../../consultation/fact-ledger/fact-ledger.service';
import { ChainSummaryService } from '../../consultation/summary/chain-summary.service';
import { ConsultationEndpointService } from '../../consultation/endpoint/consultation-endpoint.service';

const TENANT = 'tenant-1';
const CID = 'c-1';

const notices = (excluded: string[]) => ({ findAll: vi.fn(async () => (excluded.length ? [{ itemIds: excluded }] : [])) });

function lifecycle(processing: ConsultationProcessing, processingReason: string | null) {
  const row = new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'p-1',
    doctorId: 'd-1',
    appointmentDate: new Date('2026-10-07'),
    status: ConsultationStatus.PAUSED,
    processing,
    processingReason,
    currentEncounterSeq: 1,
    version: 3,
    createdAt: new Date('2026-10-07'),
    updatedAt: new Date('2026-10-07'),
  } as never);
  const consultations = { findByIdOrNull: vi.fn(async () => row), updateWithVersion: vi.fn(async () => row), touchActivity: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'd-1' } : undefined)) };
  const service = new ConsultationLifecycleService(
    consultations as never,
    { findByConsultation: vi.fn(async () => []) } as never,
    {} as never,
    {} as never,
    {} as never,
    { publish: vi.fn() } as never,
    { emit: vi.fn() } as never,
    cls as never,
  );
  return { service, consultations };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return ((error as ConflictException).getResponse() as { code?: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('start on a guardrail hold', () => {
  it('is 409 GUARDRAIL_HOLD for both hold reasons, and writes nothing', async () => {
    for (const reason of ['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE']) {
      const h = lifecycle(ConsultationProcessing.AWAITING_REVIEW, reason);
      expect(await codeOf(h.service.start(CID))).toBe('GUARDRAIL_HOLD');
      expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
    }
  });

  it('is not refused for an AWAITING_REVIEW that is not a hold (coverage gaps)', async () => {
    const h = lifecycle(ConsultationProcessing.AWAITING_REVIEW, 'COVERAGE_GAPS');
    const error = await h.service.start(CID).catch((e: unknown) => e);
    const code = error instanceof ConflictException ? (error.getResponse() as { code?: string }).code : undefined;
    expect(code).not.toBe('GUARDRAIL_HOLD');
  });
});

const seg = (id: string, seq: number, guardrailStatus?: string) => ({
  id,
  type: ContextItemType.TRANSCRIPT_SEGMENT,
  content: `segment ${id}`,
  currentVersionNumber: 1,
  encounterSeq: 1,
  segmentSeq: seq,
  speaker: 'doctor',
  t0Ms: seq * 1000,
  createdAt: new Date(Date.UTC(2026, 9, 7, 9, seq)),
  tenantId: TENANT,
  consultationId: CID,
  ...(guardrailStatus ? { guardrailStatus } : {}),
});

describe('fact ledger — guardrail exclusion', () => {
  it('builds the encounter digest without withheld or excluded segments (the composer computes the same)', async () => {
    const segments = [seg('s-1', 1), seg('s-2', 2, 'BLOCKED'), seg('s-3', 3, 'WITHHELD')];
    const repo = { findSegments: vi.fn(async () => segments), findTranscripts: vi.fn(async () => []) };
    const withExclusion = new FactLedgerService(repo as never, {} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, notices(['s-2']) as never);
    const plain = new FactLedgerService(
      { findSegments: vi.fn(async () => [seg('s-1', 1)]), findTranscripts: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(await withExclusion.computeEncounterDigest(CID, 1)).toBe(await plain.computeEncounterDigest(CID, 1));
  });
});

describe('chain summary — guardrail exclusion', () => {
  it('leaves withheld and excluded items out of the gathered sections and entities', async () => {
    const contextItems = {
      findSummaries: vi.fn(async () => []),
      findTranscripts: vi.fn(async () => [
        { ...seg('t-1', 1), type: ContextItemType.TRANSCRIPT, content: 'kept transcript' },
        { ...seg('t-2', 2, 'BLOCKED'), type: ContextItemType.TRANSCRIPT, content: 'EXCLUDED-CANARY' },
      ]),
      findCaseNotes: vi.fn(async () => [{ ...seg('n-1', 3, 'WITHHELD'), type: ContextItemType.CASE_NOTE, content: 'WITHHELD-CANARY' }]),
      findPreSummaries: vi.fn(async () => []),
    };
    const namedEntities = { findByContextItem: vi.fn(async (id: string) => [{ className: 'DRUG', text: `drug-${id}` }]) };
    const service = new ChainSummaryService(
      contextItems as never,
      {} as never,
      {} as never,
      namedEntities as never,
      { emit: vi.fn() } as never,
      { get: vi.fn(() => TENANT) } as never,
      {} as never,
      {} as never,
      ...Array.from({ length: 8 }, () => undefined),
      notices(['t-2']) as never,
    );
    const sections = await service.gatherSections([{ id: CID, tenantId: TENANT } as never]);
    const text = JSON.stringify(sections);
    expect(text).toContain('kept transcript');
    expect(text).not.toContain('EXCLUDED-CANARY');
    expect(text).not.toContain('WITHHELD-CANARY');

    const entities = await service.gatherNamedEntities([CID]);
    expect(JSON.stringify(entities)).toContain('drug-t-1');
    expect(JSON.stringify(entities)).not.toContain('drug-t-2');
  });
});

describe('endpoint service — guardrail exclusion', () => {
  it('never promotes corrections over a withheld or excluded transcript', async () => {
    const transcripts = [
      { id: 'tr-1', tenantId: TENANT, content: 'older transcript', guardrailStatus: 'CLEAN' },
      { id: 'tr-2', tenantId: TENANT, content: 'EXCLUDED', guardrailStatus: 'BLOCKED' },
    ];
    const service = new ConsultationEndpointService(
      { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT })) } as never,
      {} as never,
      { findTranscripts: vi.fn(async () => transcripts) } as never,
      {} as never,
      { emit: vi.fn() } as never,
      { get: vi.fn(() => TENANT) } as never,
      notices(['tr-2']) as never,
    );
    const resolve = (service as unknown as { resolveTranscript(t: string, c: string, id?: string | null): Promise<{ id: string } | null> }).resolveTranscript.bind(service);
    expect((await resolve(TENANT, CID))?.id).toBe('tr-1');
    expect(await resolve(TENANT, CID, 'tr-2')).toBeNull();
  });
});
