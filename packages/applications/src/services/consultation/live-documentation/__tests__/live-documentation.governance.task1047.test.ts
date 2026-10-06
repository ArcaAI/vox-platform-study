/**
 * TASK-1047 on the realtime lane.
 *
 *   - D1 / FC-2 — the turn's instructions are STATIC, KEYED contract parts (stable lead-in, directive,
 *     elision note, reference rule, operating frame, turn contract, corrective): one CONTRACT piece
 *     each, so a registered piece is recognised wherever it recurs;
 *   - D9 — the data blocks put the per-consultation context first and the growing material last:
 *     vitals → previous visits → test results → same-day visits → clinician notes → note so far →
 *     transcript;
 *   - FC-4 — every live TEXT call hands the composer's governance of the system it sent, the
 *     platform pieces and the session tenant to the ONE egress enrichment.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { platformRules } from '@arcaai/workflow-contract';
import { LiveDocumentationService } from '../live-documentation.service';

type Parts = { instructions: string; instructionParts: { key: string; text: string }[]; blocks: { key: string; content: string | null }[] };
type BuildLivePromptParts = (
  priorNote: string,
  delta: string,
  notes: string,
  elided?: boolean,
  stablePrefix?: string,
  documentTitle?: string,
  operatingFrame?: string,
  turnContract?: string,
  clientVitals?: string,
  clientPreviousVisits?: string,
  carry?: { sameDayPrequel?: string; testResults?: string },
) => Parts;

function promptBuilder(): BuildLivePromptParts {
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() } };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = { get: vi.fn(), set: vi.fn(), setex: vi.fn(), publish: vi.fn(), del: vi.fn() };
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return (service as unknown as { buildLivePromptParts: BuildLivePromptParts }).buildLivePromptParts.bind(service);
}

const TENANT = 'tenant-live-1047';
const CID = 'consultation-live-1047';

function liveService(enrichment: { applyTextRuntimeProfile: unknown; applyTenantProviderOverrides: unknown }, sent: Array<Record<string, unknown>>) {
  const post = vi.fn().mockImplementation((url: string, body: Record<string, unknown>) => {
    if (url.includes('/generate')) {
      sent.push(body);
      return Promise.resolve({ data: { summary: 'Subjective: cough\nObjective:\nAssessment:\nPlan:' } });
    }
    return Promise.resolve({ data: { entities: [] } });
  });
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post } };
  args[1] = { get: vi.fn((k: string) => (k === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[6] = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) };
  args[13] = enrichment;
  return new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
}

describe('D1 / FC-2 — the turn instructions are static, keyed contract parts', () => {
  it('keys each instruction part and keeps `instructions` as their join', () => {
    const parts = promptBuilder()('## S (s)\nprior', 'delta', 'notes', true, 'STABLE PREFIX', 'SOAP Note', '\n\nFRAME', '\n\nCONTRACT', 'BP', 'history');
    expect(parts.instructionParts.map((part) => part.key)).toEqual([
      'live-stable-prefix',
      'live-turn-directive',
      'live-elision-note',
      'live-reference-rule',
      'live-operating-frame',
      'live-turn-contract',
    ]);
    expect(parts.instructions).toBe(parts.instructionParts.map((part) => part.text).join('\n\n'));
  });

  it('no part carries a runtime value — the same parts for two different encounters', () => {
    const a = promptBuilder()('## S (s)\nNOTE-A', 'TRANSCRIPT-A', 'NOTES-A', false, 'STABLE', 'SOAP Note', 'FRAME', 'CONTRACT', 'VITALS-A', 'HISTORY-A', { testResults: 'LAB-A', sameDayPrequel: 'PREQUEL-A' });
    const b = promptBuilder()('## S (s)\nNOTE-B', 'TRANSCRIPT-B', 'NOTES-B', false, 'STABLE', 'SOAP Note', 'FRAME', 'CONTRACT', 'VITALS-B', 'HISTORY-B', { testResults: 'LAB-B', sameDayPrequel: 'PREQUEL-B' });
    expect(a.instructionParts).toEqual(b.instructionParts);
  });
});

describe('D9 — stable context first, the growing material last', () => {
  it('orders vitals, previous visits, test results, same-day visits, clinician notes, the note so far, the transcript', () => {
    const parts = promptBuilder()('## S (s)\nprior', 'delta', 'notes', false, 'STABLE', 'SOAP Note', '', '', 'BP', 'history', { testResults: 'labs', sameDayPrequel: 'earlier' });
    expect(parts.blocks.map((block) => block.key)).toEqual([
      'recent_vitals',
      'previous_case_notes_summary',
      'test_results',
      'same_day_prequel_summary',
      'clinician_notes',
      'current_note',
      'transcript',
    ]);
  });
});

describe('FC-4 — the live call hands its composed governance to the egress', () => {
  it('passes the governance of exactly the system it sent, the platform + contract pieces and the session tenant', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const enrichment = { applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined), applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined) };
    const service = liveService(enrichment, sent);
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(sent).toHaveLength(1);
    const hint = (enrichment.applyTenantProviderOverrides.mock.calls.at(-1)?.[1] as { systemGovernance: Record<string, unknown> }).systemGovernance as {
      governance: { composedDigest: string };
      platformPieces: { kind: string; sourceKey: string; text: string }[];
      tenantId: string;
    };
    expect(hint.governance.composedDigest).toBe(createHash('sha256').update(String(sent[0]!.system_prompt), 'utf8').digest('hex'));
    expect(hint.tenantId).toBe(TENANT);
    expect(hint.platformPieces[0]).toMatchObject({ kind: 'PLATFORM', text: platformRules() });
    expect(hint.platformPieces.slice(1).map((piece) => [piece.kind, piece.sourceKey])).toEqual([
      ['CONTRACT', 'live-stable-prefix'],
      ['CONTRACT', 'live-turn-directive'],
      ['CONTRACT', 'live-operating-frame'],
      ['CONTRACT', 'live-turn-contract'],
    ]);
    expect(String(sent[0]!.system_prompt)).not.toContain('Patient reports cough');
  });
});
