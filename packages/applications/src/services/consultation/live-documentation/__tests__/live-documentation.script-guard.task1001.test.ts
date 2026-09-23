/**
 * TASK-1001 wave 4 (owner decisions D-1/D-2, 2026-09-23) — the live note's output check, end to end
 * through the real flush.
 *
 * On `hope-v2-dev` consultation `01a0cd63` the live note's Plan carried a doctor instruction copied
 * verbatim from the code-switched transcript, Malayalam script and all, although every instruction
 * said English. The pure rule is pinned in `realtime/__tests__/script-guard.task1001.test.ts`; this
 * file pins what only the whole flush shows: the published `section.patch`, the persisted row and the
 * whole-document snapshot all carry the translation; a failed retry keeps the original; the check
 * applies on BOTH engines; and it stands down when the platform output language is not English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { SectionPatchDto } from '../realtime';

const CID = 'consultation-1001-script';
const TENANT = 'tenant-1001';

interface BuildOpts {
  graph: boolean;
  outputLanguage: string;
  translation: string;
}
const translateCalls: string[] = [];

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

function buildService(cache: ReturnType<typeof cacheMock>, turns: string[], sections: ReturnType<typeof sectionRepositoryDouble>, opts: BuildOpts) {
  let call = 0;
  const post = vi.fn(async (url: string, body?: { system_prompt?: string; prompt?: string }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate') && body?.system_prompt?.startsWith('Translate')) {
      translateCalls.push(body.prompt ?? '');
      return { data: { summary: opts.translation } };
    }
    if (url.includes('/generate')) return { data: { summary: turns[Math.min(call++, turns.length - 1)] } };
    return { data: {} };
  });

  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
        ? { value: opts.graph, sourceScope: 'tenant' }
        : key === CONSULTATION_OUTPUT_LANGUAGE_KEY
          ? { value: opts.outputLanguage, sourceScope: 'system' }
          : { value: undefined, sourceScope: 'code-default' },
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

async function drive(turns: string[], segments: string[], opts: BuildOpts) {
  const cache = cacheMock();
  const sections = sectionRepositoryDouble();
  translateCalls.length = 0;
  const service = buildService(cache, turns, sections, opts);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));

  for (const [idx, text] of segments.entries()) {
    service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${idx}` });
    await service.flush(CID, { force: true });
  }
  // Captured BEFORE `stop()`, whose final forced flush would otherwise be the last sample.
  const stats = statsOf(cache);
  await service.stop(CID, { persistSnapshot: false });
  return { cache, sections, stats, patches: patchesOf(cache), published: cache.published };
}

/** Synthetic text in the reported shape: an English plan line with a Malayalam instruction inside. */
const LEAKED = 'Folic acid 5mg ഓട് follow ചെയ്യണം.';
const TRANSLATED = 'Continue folic acid 5 mg.';
const CLEAN = 'Iron deficiency anaemia.';
/** `stop()` runs one more forced flush; this is what the model says to it. */
const QUIET = turn({});

const flushLines = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((fields) => fields?.message === 'Live summary flush');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TASK-1001 wave 4 — the live note is held to English', () => {
  it('graph engine: translates the leaked section once, and publishes + persists the translation', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const { patches, sections } = await drive(
      [turn({ assessment: { addition: CLEAN }, plan: { addition: LEAKED } }), QUIET],
      ['the doctor explains the plan'],
      {
        graph: true,
        outputLanguage: 'en',
        translation: TRANSLATED,
      },
    );

    expect(translateCalls).toEqual([LEAKED]);
    expect(patches.find((patch) => patch.sectionKey === 'plan')?.content).toBe(TRANSLATED);
    expect(patches.find((patch) => patch.sectionKey === 'assessment')?.content).toBe(CLEAN);
    const row = [...sections.rows.values()].find((entry) => entry.sectionKey === 'plan')!;
    expect(row.entity.content).toBe(TRANSLATED);

    const line = flushLines(logSpy).find((fields) => fields.turnScriptRepairs === 1);
    expect(line, 'no flush line reported the repair').toBeDefined();
    expect(line!.turnScriptRepairsUnresolved).toBe(0);
    expect(JSON.stringify(line)).not.toContain('Folic');
  });

  it('legacy engine: the whole-document snapshot carries the translation', async () => {
    const { published } = await drive([turn({ plan: { addition: LEAKED } }), QUIET], ['the doctor explains the plan'], {
      graph: false,
      outputLanguage: 'en',
      translation: TRANSLATED,
    });

    expect(translateCalls).toEqual([LEAKED]);
    const snapshots = published.filter((p) => Array.isArray((p as { sections?: unknown }).sections)) as Array<{
      sections: Array<{ content: string }>;
    }>;
    expect(snapshots.length).toBeGreaterThan(0);
    const text = JSON.stringify(snapshots.at(-1)!.sections);
    expect(text).toContain(TRANSLATED);
    expect(text).not.toMatch(/[\u0D00-\u0D7F]/);
  });

  it('a retry that still leaks keeps the model’s original text and counts it unresolved (D-2)', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const { patches } = await drive([turn({ plan: { addition: LEAKED } }), QUIET], ['the doctor explains the plan'], {
      graph: true,
      outputLanguage: 'en',
      translation: 'still ഓട്',
    });

    expect(patches.find((patch) => patch.sectionKey === 'plan')?.content).toBe(LEAKED);
    expect(flushLines(logSpy).some((fields) => fields.turnScriptRepairsUnresolved === 1)).toBe(true);
  });

  it('stands down when the platform output language is not English (D-1)', async () => {
    const { patches } = await drive([turn({ plan: { addition: LEAKED } }), QUIET], ['the doctor explains the plan'], {
      graph: true,
      outputLanguage: 'ml',
      translation: TRANSLATED,
    });

    expect(translateCalls).toEqual([]);
    expect(patches.find((patch) => patch.sectionKey === 'plan')?.content).toBe(LEAKED);
  });

  it('a clean turn costs no extra model call', async () => {
    await drive([turn({ plan: { addition: CLEAN } }), QUIET], ['the doctor explains the plan'], {
      graph: true,
      outputLanguage: 'en',
      translation: TRANSLATED,
    });
    expect(translateCalls).toEqual([]);
  });
});
