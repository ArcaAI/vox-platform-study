/**
 * TASK-939 — the owner's requirement, end to end through the real flush.
 *
 * > "when it run partial summarization using a segment of transcript, it always refresh by cleanup
 * > and redisplay the whole existing consultation case note … it MUST follow the behavior of
 * > incremental adding partial summary into the current case note containing some previous summary
 * > parts."
 *
 * Every other TASK-939 test proves one piece in isolation (the entity's append, the store's append
 * mode, the turn contract's fold). This one drives `LiveDocumentationService` itself across three
 * turns with a model that emits TURNS, and asserts the property the owner actually asked for:
 *
 *   **For every section, across consecutive revisions, the text already published is a PREFIX of
 *   the text published next** — unless the turn named a transcript contradiction.
 *
 * That invariant is the machine-checkable form of "the note accumulates instead of being rebuilt",
 * and it is what a replay against a real recording measures as `noteChurn`.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { SectionPatchDto } from '../realtime';

const CID = 'consultation-939';
const TENANT = 'tenant-939';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-09T00:00:00.000Z',
});

function cacheMock() {
  const published: unknown[] = [];
  return {
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
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

/**
 * An in-memory `DocumentSection` repository. Real enough to matter: the append the store performs
 * is against the STORED row, so a double that forgot content would make accumulation untestable.
 */
function sectionRepositoryDouble() {
  const rows = new Map<string, { documentKey: string; sectionKey: string; entity: unknown }>();
  const key = (d: string, s: string) => `${d}::${s}`;
  return {
    rows,
    findSection: vi.fn(async (_t: string, _c: string, d: string, s: string) => (rows.get(key(d, s))?.entity ?? null) as never),
    create: vi.fn(async (entity: { documentKey: string; sectionKey: string }) => {
      rows.set(key(entity.documentKey, entity.sectionKey), { documentKey: entity.documentKey, sectionKey: entity.sectionKey, entity });
      return entity as never;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: { documentKey: string; sectionKey: string; _version?: number }, expected: number) => {
      (entity as { _version: number })._version = expected + 1;
      rows.set(key(entity.documentKey, entity.sectionKey), { documentKey: entity.documentKey, sectionKey: entity.sectionKey, entity });
      return entity as never;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

/** The turn each `/generate` call answers with, in order. */
function buildService(cache: ReturnType<typeof cacheMock>, turns: string[], sections: ReturnType<typeof sectionRepositoryDouble>) {
  const prompts: string[] = [];
  let call = 0;
  const post = vi.fn(async (url: string, body: { prompt?: string }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      prompts.push(body?.prompt ?? '');
      return { data: { summary: turns[Math.min(call++, turns.length - 1)] } };
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
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
    undefined, // workflowAssignments
    undefined, // workflowDefinitionRepository
    // Position matters: `documentSectionRepository` is the 19th parameter, and the per-section
    // plane is silently `unavailable` without it — which is exactly how this test first produced
    // zero patches.
    sections as never,
  );

  return { service, prompts, post };
}

const turn = (body: Record<string, unknown>) =>
  JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

const patchesOf = (cache: ReturnType<typeof cacheMock>): SectionPatchDto[] =>
  cache.published.filter((p): p is SectionPatchDto => (p as SectionPatchDto).event === 'section.patch');

async function drive(turns: string[], segments: string[]) {
  const cache = cacheMock();
  const sections = sectionRepositoryDouble();
  const { service, prompts } = buildService(cache, turns, sections);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));

  for (const [idx, text] of segments.entries()) {
    service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${idx}` });
    await service.flush(CID, { force: true });
  }
  const final = await service.stop(CID, { persistSnapshot: false });
  return { cache, prompts, final, patches: patchesOf(cache) };
}

describe('TASK-939 — the case note ACCUMULATES across partial-summary turns', () => {
  it('THE REQUIREMENT: each section’s published text is a PREFIX of what it publishes next', async () => {
    const { patches } = await drive(
      [
        turn({ subjective: { addition: 'Cough for three days.' } }),
        turn({ subjective: { addition: 'Now reports fever.' } }),
        turn({ subjective: { addition: 'Denies chest pain.' } }),
      ],
      ['patient reports a cough', 'and now a fever', 'no chest pain'],
    );

    const subjective = patches.filter((patch) => patch.sectionKey === 'subjective').sort((a, b) => a.revision - b.revision);
    expect(subjective.length).toBeGreaterThanOrEqual(3);

    for (let i = 1; i < subjective.length; i++) {
      expect(
        subjective[i]!.content.startsWith(subjective[i - 1]!.content),
        `revision ${subjective[i]!.revision} rewrote earlier text instead of adding to it`,
      ).toBe(true);
    }
    expect(subjective.at(-1)!.content).toBe('Cough for three days.\n\nNow reports fever.\n\nDenies chest pain.');
  });

  it('each patch names only what it ADDED, so a renderer need not re-animate the whole section', async () => {
    const { patches } = await drive(
      [turn({ subjective: { addition: 'Cough for three days.' } }), turn({ subjective: { addition: 'Now reports fever.' } })],
      ['cough', 'fever'],
    );

    const second = patches.filter((patch) => patch.sectionKey === 'subjective').sort((a, b) => a.revision - b.revision).at(-1)!;
    expect(second.appended).toBe('Now reports fever.');
    expect(second.content).toBe('Cough for three days.\n\nNow reports fever.');
  });

  it('a section the turn said nothing about publishes NO patch — a quiet section is not churn', async () => {
    const { patches } = await drive(
      [turn({ subjective: { addition: 'Cough for three days.' } }), turn({ objective: { addition: 'Temp 37.8.' } })],
      ['cough', 'temperature thirty seven eight'],
    );

    // Two turns, two sections, one patch each — never four.
    expect(patches.map((patch) => [patch.sectionKey, patch.revision])).toEqual([
      ['subjective', 1],
      ['objective', 1],
    ]);
  });

  it('a REVISION with a contradiction replaces the section, and is the ONLY way earlier text changes', async () => {
    const { patches } = await drive(
      [
        turn({ objective: { addition: 'Temp 37.8.' } }),
        turn({ objective: { revision: 'Temp 39.1.', contradiction: 'Nurse restated the reading as 39.1.' } }),
      ],
      ['temp thirty seven eight', 'correction, thirty nine point one'],
    );

    const objective = patches.filter((patch) => patch.sectionKey === 'objective').sort((a, b) => a.revision - b.revision);
    expect(objective.at(-1)!.content).toBe('Temp 39.1.');
    // A replace is not an append, so it carries no `appended`.
    expect(objective.at(-1)!.appended).toBeUndefined();
  });

  it('an UNJUSTIFIED rewrite is refused — the prior text stands and nothing is published', async () => {
    const { patches } = await drive(
      [turn({ objective: { addition: 'Temp 37.8.' } }), turn({ objective: { revision: 'Temperature thirty-seven point eight.' } })],
      ['temp thirty seven eight', 'restating it differently'],
    );

    const objective = patches.filter((patch) => patch.sectionKey === 'objective');
    expect(objective).toHaveLength(1);
    expect(objective[0]!.content).toBe('Temp 37.8.');
  });

  it('the prompt carries the prior note BY KEY, so the model can address one section', async () => {
    const { prompts } = await drive(
      [turn({ subjective: { addition: 'Cough for three days.' } }), turn({ subjective: { addition: 'Now fever.' } })],
      ['cough', 'fever'],
    );

    // The structural fix (§2.2): the prior note used to arrive as an unlabelled `\n\n` join of
    // bodies, so the model had to re-derive the partition and re-emit everything.
    expect(prompts[1]).toContain('## Subjective (subjective)');
    expect(prompts[1]).toContain('Cough for three days.');
    // And the turn contract tells it to add rather than reproduce.
    expect(prompts[1]).toContain('WHAT TO EMIT THIS TURN:');
  });

  it('the final published note is the accumulation, not the last turn alone', async () => {
    const { final } = await drive(
      [
        turn({ subjective: { addition: 'Cough for three days.' } }),
        turn({ objective: { addition: 'Temp 37.8.' } }),
        turn({ assessment: { addition: 'Likely viral URI.' } }),
      ],
      ['cough', 'temp', 'assessment'],
    );

    expect(final!.runningSummary).toContain('Cough for three days.');
    expect(final!.runningSummary).toContain('Temp 37.8.');
    expect(final!.runningSummary).toContain('Likely viral URI.');
  });
});

describe('TASK-939 R7 — the churn metric makes the defect measurable', () => {
  /**
   * `noteChurnChars` is computed from the note BEFORE and AFTER the turn, not from the write list:
   * a metric that read this code's own claims about what it did could never catch an "append" that
   * actually replaced. Zero is the design target.
   */
  const statsOf = (cache: { setexCalls: Array<{ key: string; raw: string }> }) =>
    cache.setexCalls.filter((c) => c.key.startsWith('live-doc:stats:')).map((c) => JSON.parse(c.raw) as Record<string, unknown>);

  function statsCache() {
    const setexCalls: Array<{ key: string; raw: string }> = [];
    const base = cacheMock();
    return Object.assign(base, {
      setexCalls,
      setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
        setexCalls.push({ key, raw });
      }),
    });
  }

  async function driveWithStats(turns: string[], segments: string[]) {
    const cache = statsCache();
    const sections = sectionRepositoryDouble();
    const { service } = buildService(cache as never, turns, sections);
    service.start({ consultationId: CID, tenantId: TENANT });
    await new Promise((resolve) => setImmediate(resolve));
    for (const [idx, text] of segments.entries()) {
      service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${idx}` });
      await service.flush(CID, { force: true });
    }
    // Snapshots are read BEFORE `stop()`. Stop runs a final forced flush, and with no new
    // transcript that turn legitimately has nothing to add (the model repeats itself and
    // `applyTurn` drops an addition the section already contains), so it publishes a zero-write
    // snapshot that would make `at(-1)` the wrong sample for every assertion here.
    const captured = statsOf(cache);
    await service.stop(CID, { persistSnapshot: false });
    return captured;
  }

  it('reports ZERO churn for a purely additive session — the healthy line', async () => {
    const stats = await driveWithStats(
      [turn({ subjective: { addition: 'Cough for three days.' } }), turn({ subjective: { addition: 'Now reports fever.' } })],
      ['cough', 'fever'],
    );

    expect(stats.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of stats) expect(snapshot.noteChurnChars).toBe(0);
    expect(stats.at(-1)!.turnSectionsAppended).toBe(1);
    expect(stats.at(-1)!.turnSectionsRewritten).toBe(0);
  });

  it('reports the churn of a JUSTIFIED rewrite — legitimate, but still counted', async () => {
    const stats = await driveWithStats(
      [
        turn({ objective: { addition: 'Temp 37.8.' } }),
        turn({ objective: { revision: 'Temp 39.1.', contradiction: 'Nurse restated the reading.' } }),
      ],
      ['temp', 'correction'],
    );

    expect(stats.at(-1)!.noteChurnChars).toBe('Temp 37.8.'.length);
    expect(stats.at(-1)!.turnSectionsRewritten).toBe(1);
  });

  it('counts a refused rewrite without charging churn for it — the prior text stood', async () => {
    const stats = await driveWithStats(
      [turn({ objective: { addition: 'Temp 37.8.' } }), turn({ objective: { revision: 'Thirty-seven point eight degrees.' } })],
      ['temp', 'restated'],
    );

    expect(stats.at(-1)!.turnRefusedRewrites).toBe(1);
    expect(stats.at(-1)!.noteChurnChars).toBe(0);
  });

  it('flags the whole-document DEGRADE, so a tenant stuck on the old behaviour is visible', async () => {
    // A provider that answers with the document rather than with its contribution.
    const stats = await driveWithStats(
      [JSON.stringify({ subjective: 'Cough for three days.', objective: null, assessment: null, plan: null })],
      ['cough'],
    );

    expect(stats.at(-1)!.turnDegraded).toBe(true);
  });
});
