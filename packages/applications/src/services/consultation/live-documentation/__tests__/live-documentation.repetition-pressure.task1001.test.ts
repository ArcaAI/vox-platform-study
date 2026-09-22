/**
 * TASK-1001 Phase 5 (OD-6) — repetition pressure becomes VISIBLE.
 *
 * ## What was invisible
 *
 * The turn contract has refused unjustified rewrites since TASK-939 and counted them on the stats
 * as `turnRefusedRewrites`. In the reported incident **11 of 13 flushes carried refusals, peaking
 * at 4 in one flush** — and nothing said so. A count with no threshold beside it is a number a
 * reader has nothing to compare against, so every repetitive flush looked exactly like a healthy
 * one and the first anyone knew of the problem was a tester reading a note that said the same
 * clinical sentences six times.
 *
 * ## What this pins
 *
 *  - the THRESHOLD, as a pure function, at its boundary — including that it is a SUM of refused
 *    rewrites and dropped sentences, because those are one behaviour measured at two
 *    granularities (a whole refused revision, and a sentence dropped inside an accepted addition);
 *  - that `repetition_pressure` is in the CLOSED vocabulary, so a consumer can enumerate it;
 *  - that a repetitive flush actually publishes it on the admin stats snapshot, and an ordinary
 *    one does not — a signal that fires on 85% of flushes is not a signal;
 *  - that a FAILED flush keeps its own reason: "there is no note" outranks "the note repeats".
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import {
  LIVE_DEGRADE_CODES,
  LIVE_DEGRADE_FALLBACK,
  LIVE_DEGRADE_REPETITION_PRESSURE,
  LIVE_REPETITION_PRESSURE_THRESHOLD,
  repetitionPressureCode,
} from '../degrade-codes';

const CID = 'consultation-1001-repetition';
const TENANT = 'tenant-1001';

// =================================================================================================
// The rule, on its own
// =================================================================================================

describe('`repetitionPressureCode` — the threshold, and why it is a sum', () => {
  it('is in the closed vocabulary, so a consumer can enumerate it', () => {
    expect(LIVE_DEGRADE_CODES).toContain(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(LIVE_DEGRADE_REPETITION_PRESSURE).toBe('repetition_pressure');
  });

  it('stays quiet below the threshold — one restatement is the ordinary background of an additive contract', () => {
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 0 })).toBeUndefined();
    expect(repetitionPressureCode({ refusedRewrites: 1, droppedSentences: 0 })).toBeUndefined();
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 2 })).toBeUndefined();
    expect(repetitionPressureCode({ refusedRewrites: 1, droppedSentences: 1 })).toBeUndefined();
  });

  it('fires AT the threshold', () => {
    expect(LIVE_REPETITION_PRESSURE_THRESHOLD).toBe(3);
    expect(repetitionPressureCode({ refusedRewrites: 3, droppedSentences: 0 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(repetitionPressureCode({ refusedRewrites: 0, droppedSentences: 3 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
  });

  it('SUMS the two counts — a flush that does a little of each is the one a per-count threshold misses', () => {
    expect(repetitionPressureCode({ refusedRewrites: 2, droppedSentences: 1 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    expect(repetitionPressureCode({ refusedRewrites: 1, droppedSentences: 2 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
  });

  it('fires on the incident`s worst flush (4 refusals) — the case an operator needed to see', () => {
    expect(repetitionPressureCode({ refusedRewrites: 4, droppedSentences: 0 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
  });

  it('treats a negative count as zero rather than letting it cancel the other one out', () => {
    expect(repetitionPressureCode({ refusedRewrites: -10, droppedSentences: 3 })).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
  });
});

// =================================================================================================
// …and through the real flush
// =================================================================================================

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-22T00:00:00.000Z',
});

/** A cache that records what `publishStats` wrote, the way the admin console would read it. */
function statsCache() {
  const setexCalls: Array<{ key: string; raw: string }> = [];
  return {
    setexCalls,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      setexCalls.push({ key, raw });
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/** Each `/generate` answers with the next turn; `null` makes the call FAIL instead. */
function buildService(cache: ReturnType<typeof statsCache>, turns: Array<string | null>) {
  let call = 0;
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      const body = turns[Math.min(call++, turns.length - 1)];
      if (body === null) throw new Error('TEXT is unreachable');
      return { data: { summary: body } };
    }
    return { data: {} };
  });

  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  const service = new LiveDocumentationService(
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
    // Positional, like every sibling suite here: 16 `workflowAssignments`, 17
    // `workflowDefinitionRepository`, 18 `documentSectionRepository`. None is needed to publish
    // stats, and passing them explicitly keeps the arity aligned with the constructor.
    undefined,
    undefined,
    undefined,
  );

  return { service };
}

const turn = (body: Record<string, unknown>) => JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

/** One stats snapshot per flush, in flush order. */
const statsOf = (cache: ReturnType<typeof statsCache>) =>
  cache.setexCalls.filter((c) => c.key.startsWith('live-doc:stats:')).map((c) => JSON.parse(c.raw) as Record<string, unknown>);

async function driveWithStats(turns: Array<string | null>, segments: string[]) {
  const cache = statsCache();
  const { service } = buildService(cache, turns);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  for (const [idx, text] of segments.entries()) {
    service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${idx}` });
    await service.flush(CID, { force: true });
  }
  // Read BEFORE `stop()`: stop runs a final forced flush with no new transcript, which would make
  // `at(-1)` a different sample from the one under test (the same caveat TASK-939's suite records).
  const captured = statsOf(cache);
  await service.stop(CID, { persistSnapshot: false });
  return captured;
}

/** Turn 1 establishes three sections; turn 2 re-words all three with no contradiction named. */
const THREE_UNJUSTIFIED_REWRITES = [
  turn({
    subjective: { addition: 'Cough for three days.' },
    objective: { addition: 'Temp 37.8.' },
    assessment: { addition: 'Likely viral upper respiratory infection.' },
  }),
  turn({
    subjective: { revision: 'The patient has had a cough for three days.' },
    objective: { revision: 'Temperature is thirty-seven point eight.' },
    assessment: { revision: 'Viral upper respiratory infection is likely.' },
  }),
];

describe('a repetitive flush reports `repetition_pressure` on the admin stats snapshot', () => {
  it('publishes the code, and the counts beside it, when the turn re-says three sections', async () => {
    const stats = await driveWithStats(THREE_UNJUSTIFIED_REWRITES, ['cough', 'the same again']);

    const last = stats.at(-1)!;
    expect(last.turnRefusedRewrites, 'the harness did not produce three refusals').toBe(3);
    expect(last.degradeReason).toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
    // The note EXISTS. A consumer distinguishes the two cases by `flushFailed`, which is the
    // field that has always answered it.
    expect(last.flushFailed).toBe(false);
  });

  it('stays silent on an ordinary flush — one refusal is not pressure', async () => {
    const stats = await driveWithStats(
      [
        turn({ subjective: { addition: 'Cough for three days.' } }),
        turn({ subjective: { revision: 'The patient has had a cough for three days.' } }),
      ],
      ['cough', 'restated'],
    );

    const last = stats.at(-1)!;
    expect(last.turnRefusedRewrites).toBe(1);
    expect(last.degradeReason).toBeUndefined();
  });

  it('stays silent on a purely additive flush — the healthy line is unchanged', async () => {
    const stats = await driveWithStats(
      [turn({ subjective: { addition: 'Cough for three days.' } }), turn({ objective: { addition: 'Temp 37.8.' } })],
      ['cough', 'temperature'],
    );

    for (const snapshot of stats) {
      expect(snapshot.turnRefusedRewrites).toBe(0);
      expect(snapshot.degradeReason).toBeUndefined();
    }
  });

  it('a FAILED flush keeps its own reason — "there is no note" outranks "the note repeats itself"', async () => {
    const stats = await driveWithStats([null], ['cough']);

    const last = stats.at(-1)!;
    expect(last.flushFailed).toBe(true);
    expect(last.degradeReason).toBe(LIVE_DEGRADE_FALLBACK);
    expect(last.degradeReason).not.toBe(LIVE_DEGRADE_REPETITION_PRESSURE);
  });
});
