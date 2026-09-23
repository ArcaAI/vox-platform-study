/**
 * TASK-1001 (wave 2) — a paragraph one turn writes into TWO sections, end to end through the real
 * flush.
 *
 * The turn contract flags it (`turn-contract.cross-section.task1001.test.ts`) and the store keeps the
 * flag (`section-store.duplicate.task1001.test.ts`). This file drives `LiveDocumentationService`
 * itself and pins the three things only the whole flush can show:
 *
 *  - the `duplicate` annotation reaches the `section.patch` the console renders AND the persisted
 *    `DocumentSection` row, and survives the next turn's append to the same section;
 *  - every write still happens, byte for byte — nothing is dropped for being a repeat;
 *  - the flagged runs count toward `repetition_pressure` and appear on the `Live summary flush` line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import { LIVE_DEGRADE_REPETITION_PRESSURE, repetitionPressureCode } from '../degrade-codes';
import type { SectionAnnotationDto, SectionPatchDto } from '../realtime';

const CID = 'consultation-1001-xsection';
const TENANT = 'tenant-1001';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-23T00:00:00.000Z',
});

/** Records both the published channel messages and the stats snapshots `publishStats` writes. */
function cacheMock() {
  const published: unknown[] = [];
  const setexCalls: Array<{ key: string; raw: string }> = [];
  return {
    published,
    setexCalls,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      setexCalls.push({ key, raw });
    }),
    publish: vi.fn(async (_channel: string, raw: string) => {
      published.push(JSON.parse(raw));
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/** An in-memory `DocumentSection` repository — the append lands on the STORED row. */
function sectionRepositoryDouble() {
  const rows = new Map<string, { sectionKey: string; entity: { annotations?: unknown; content?: string | null } }>();
  const key = (d: string, s: string) => `${d}::${s}`;
  return {
    rows,
    findSection: vi.fn(async (_t: string, _c: string, d: string, s: string) => (rows.get(key(d, s))?.entity ?? null) as never),
    create: vi.fn(async (entity: { documentKey: string; sectionKey: string }) => {
      rows.set(key(entity.documentKey, entity.sectionKey), { sectionKey: entity.sectionKey, entity: entity as never });
      return entity as never;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: { documentKey: string; sectionKey: string }, expected: number) => {
      (entity as { _version?: number })._version = expected + 1;
      rows.set(key(entity.documentKey, entity.sectionKey), { sectionKey: entity.sectionKey, entity: entity as never });
      return entity as never;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

function buildService(cache: ReturnType<typeof cacheMock>, turns: string[], sections: ReturnType<typeof sectionRepositoryDouble>) {
  let call = 0;
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) return { data: { summary: turns[Math.min(call++, turns.length - 1)] } };
    return { data: {} };
  });

  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  return new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(async () => 'cipher'), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    effectiveSettings as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null })) } as never,
    undefined, // workflowAssignments
    undefined, // workflowDefinitionRepository
    // 19th: `documentSectionRepository`. Without it the per-section plane is `unavailable`.
    sections as never,
  );
}

const turn = (body: Record<string, unknown>) => JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

const patchesOf = (cache: ReturnType<typeof cacheMock>): SectionPatchDto[] =>
  cache.published.filter((p): p is SectionPatchDto => (p as SectionPatchDto).event === 'section.patch');

const statsOf = (cache: ReturnType<typeof cacheMock>) =>
  cache.setexCalls.filter((c) => c.key.startsWith('live-doc:stats:')).map((c) => JSON.parse(c.raw) as Record<string, unknown>);

const duplicatesIn = (annotations: unknown) => ((annotations ?? []) as SectionAnnotationDto[]).filter((a) => a.kind === 'duplicate');

async function drive(turns: string[], segments: string[]) {
  const cache = cacheMock();
  const sections = sectionRepositoryDouble();
  const service = buildService(cache, turns, sections);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));

  for (const [idx, text] of segments.entries()) {
    service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${idx}` });
    await service.flush(CID, { force: true });
  }
  // Captured BEFORE `stop()`, whose final forced flush would otherwise be the last sample.
  const stats = statsOf(cache);
  await service.stop(CID, { persistSnapshot: false });
  return { cache, sections, stats, patches: patchesOf(cache) };
}

/** The observed shape: one two-sentence paragraph. Synthetic text. */
const PARAGRAPH = [
  'The patient mentioned that symptoms such as cough and repeated fever are caused by bacteria in the gut.',
  'The patient also noted that rheumatoid arthritis and psoriasis are related to gut issues.',
].join(' ');
const LATER = 'Plan to review the stool culture in clinic next week.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TASK-1001 (wave 2) — a cross-section repeat through the real flush', () => {
  it('publishes AND persists the `duplicate` flag on the later section, and writes both sections verbatim', async () => {
    const { patches, sections } = await drive(
      [turn({ subjective: { addition: PARAGRAPH }, assessment: { addition: PARAGRAPH } })],
      ['the patient describes gut symptoms'],
    );

    const subjective = patches.find((patch) => patch.sectionKey === 'subjective');
    const assessment = patches.find((patch) => patch.sectionKey === 'assessment');
    expect(subjective?.content).toBe(PARAGRAPH);
    expect(assessment?.content).toBe(PARAGRAPH);

    // The EARLIER section (template order) carries no flag.
    expect(duplicatesIn(subjective?.annotations)).toEqual([]);

    const expected = { kind: 'duplicate', start: 0, end: PARAGRAPH.length, duplicateOf: 'subjective', duplicateOfTitle: 'Subjective' };
    // PUBLISHED on the section.patch …
    expect(duplicatesIn(assessment?.annotations)).toEqual([expected]);
    expect(assessment!.content.slice(expected.start, expected.end)).toBe(PARAGRAPH);
    // … and PERSISTED on the row.
    const row = [...sections.rows.values()].find((entry) => entry.sectionKey === 'assessment')!;
    expect(duplicatesIn(row.entity.annotations)).toEqual([expected]);
  });

  it('the flag SURVIVES the next turn`s append to the same section, at the same offsets', async () => {
    const { patches } = await drive(
      [turn({ subjective: { addition: PARAGRAPH }, assessment: { addition: PARAGRAPH } }), turn({ assessment: { addition: LATER } })],
      ['the patient describes gut symptoms', 'and a follow-up plan'],
    );

    const assessment = patches.filter((patch) => patch.sectionKey === 'assessment').sort((a, b) => a.revision - b.revision);
    expect(assessment.length).toBeGreaterThanOrEqual(2);
    const latest = assessment.at(-1)!;

    expect(latest.content).toBe(`${PARAGRAPH}\n\n${LATER}`);
    const [flag, ...others] = duplicatesIn(latest.annotations);
    expect(others).toEqual([]);
    expect(flag).toMatchObject({ start: 0, end: PARAGRAPH.length, duplicateOf: 'subjective', duplicateOfTitle: 'Subjective' });
    expect(latest.content.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
  });
});

describe('TASK-1001 (wave 2) — flagged runs count toward `repetition_pressure`', () => {
  it('adds the cross-section count to the sum, and treats it like the other two', () => {
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 0, crossSectionDuplicates: 2 })).toBeUndefined();
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 0, crossSectionDuplicates: 3 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(repetitionPressureCode({ refusedRewrites: 1, droppedSentences: 1, crossSectionDuplicates: 1 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 3, crossSectionDuplicates: -10 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    // Omitted ⇒ zero, so every caller written before the third count behaves exactly as it did.
    expect(repetitionPressureCode({ refusedRewrites: 1, droppedSentences: 1 })).toBeUndefined();
  });

  it('a flush that repeats one paragraph into three more sections reports `repetition_pressure` — and still writes all four', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const { stats, patches } = await drive(
      [
        turn({
          subjective: { addition: PARAGRAPH },
          objective: { addition: PARAGRAPH },
          assessment: { addition: PARAGRAPH },
          plan: { addition: PARAGRAPH },
        }),
      ],
      ['the patient describes gut symptoms'],
    );

    // Nothing was dropped: every section got the paragraph, verbatim.
    for (const key of ['subjective', 'objective', 'assessment', 'plan']) {
      expect(patches.find((patch) => patch.sectionKey === key)?.content).toBe(PARAGRAPH);
    }
    // Three later sections, three flags, all pointing at the first.
    const flagged = patches.filter((patch) => duplicatesIn(patch.annotations).length > 0);
    expect(flagged.map((patch) => patch.sectionKey).sort()).toEqual(['assessment', 'objective', 'plan']);
    for (const patch of flagged) expect(duplicatesIn(patch.annotations)[0]).toMatchObject({ duplicateOf: 'subjective' });

    const last = stats.at(-1)!;
    expect(last.turnRefusedRewrites, 'this flush refused nothing — the pressure is the flags alone').toBe(0);
    expect(last.flushFailed).toBe(false);
    expect(last.degradeReason).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);

    // Surfaced on the same `Live summary flush` line as the other turn counters — a count, never text.
    const flushLines = logSpy.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((fields) => fields?.message === 'Live summary flush');
    expect(flushLines.length).toBeGreaterThan(0);
    for (const fields of flushLines) expect(typeof fields.turnCrossSectionDuplicates).toBe('number');
    const flagging = flushLines.find((fields) => fields.turnCrossSectionDuplicates === 3);
    expect(flagging, 'no flush line reported the three flagged runs').toBeDefined();
    expect(flagging!.repetitionPressure).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(JSON.stringify(flagging)).not.toContain('bacteria');
  });
});
