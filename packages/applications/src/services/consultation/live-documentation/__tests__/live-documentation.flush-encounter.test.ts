/**
 * The live flush writes, and resumes from, the CURRENT encounter's section rows only.
 *
 * Section rows outlive the append of a new encounter. Before this, encounter 2's first session
 * resumed encounter 1's persisted note as its "prior note" (so the model continued encounter 1's
 * draft), and every write to a section encounter 1 had LOCKED was refused — that section never
 * existed in encounter 2. Within one encounter, resume and the lock are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { SectionPatchDto } from '../realtime';
import { DocumentSectionFactory } from '@arcaai/domains';

const CID = 'consultation-enc-flush';
const TENANT = 'tenant-enc-flush';

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
function buildService(cache: ReturnType<typeof cacheMock>, turns: string[], sections: unknown, currentEncounterSeq: number) {
  const prompts: string[] = [];
  let call = 0;
  const post = vi.fn(async (url: string, body: { prompt?: string; system_prompt?: string }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      // Everything the model reads: the system message (instructions), then the user (data).
      prompts.push(`${body?.system_prompt ?? ''}\n\n${body?.prompt ?? ''}`);
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
    { findById: vi.fn(async () => ({ id: CID, metadata: null, currentEncounterSeq })) } as never,
    undefined, // workflowAssignments
    undefined, // workflowDefinitionRepository
    // Position matters: `documentSectionRepository` is the 19th parameter, and the per-section
    // plane is silently `unavailable` without it — which is exactly how this test first produced
    // zero patches.
    sections as never,
  );

  return { service, prompts, post };
}

const turn = (body: Record<string, unknown>) => JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

const patchesOf = (cache: ReturnType<typeof cacheMock>): SectionPatchDto[] =>
  cache.published.filter((p): p is SectionPatchDto => (p as SectionPatchDto).event === 'section.patch');

/** A LOCKED `subjective` row with `body`, stamped with `encounterSeq` (undefined ⇒ unstamped). */
function lockedRow(body: string, encounterSeq?: number) {
  const entity = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CID,
    documentKey: 'soap_note',
    sectionKey: 'subjective',
    title: 'Subjective',
    idx: 0,
    documentTemplateVersionId: null,
    createdBy: null,
  });
  entity.applyMachineContent(body);
  entity.lock();
  if (encounterSeq !== undefined) entity.metaData = { encounterSeq };
  return entity;
}

function repositoryWith(entity: ReturnType<typeof lockedRow>) {
  const repo = sectionRepositoryDouble();
  repo.rows.set('soap_note::subjective', { documentKey: 'soap_note', sectionKey: 'subjective', entity });
  return Object.assign(repo, {
    findByDocument: vi.fn(async () => [...repo.rows.values()].map((row) => row.entity) as never),
    decryptContentFromEntity: vi.fn(async (row: { content?: string | null }) => row.content ?? null),
  });
}

async function oneTurn(row: ReturnType<typeof lockedRow>, currentEncounterSeq: number) {
  const cache = cacheMock();
  const sections = repositoryWith(row);
  const { service, prompts } = buildService(
    cache,
    [turn({ subjective: { addition: 'Follow-up: wound healing well.' } })],
    sections,
    currentEncounterSeq,
  );
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'the wound is healing well', isFinal: true, segmentId: 's1' });
  await service.flush(CID, { force: true });
  await service.stop(CID, { persistSnapshot: false });
  const stored = sections.rows.get('soap_note::subjective')!.entity as ReturnType<typeof lockedRow>;
  return { prompts, patches: patchesOf(cache), stored };
}

describe('live flush — encounter-scoped section rows', () => {
  it('encounter 2 does not resume encounter 1’s note, and writes the section encounter 1 locked', async () => {
    const { prompts, patches, stored } = await oneTurn(lockedRow('Allergic to allopurinol?', 1), 2);

    expect(prompts[0]).not.toContain('Allergic to allopurinol?');
    const subjective = patches.filter((patch) => patch.sectionKey === 'subjective');
    expect(subjective.length).toBeGreaterThan(0);
    expect(subjective.at(-1)!.content).toBe('Follow-up: wound healing well.');
    expect(subjective.at(-1)!.state).toBe('provisional');
    expect((stored.metaData as Record<string, unknown>).encounterSeq).toBe(2);
  });

  it('within encounter 1 the locked section still refuses and the note still resumes', async () => {
    const { prompts, patches, stored } = await oneTurn(lockedRow('Allergic to allopurinol?'), 1);

    expect(prompts[0]).toContain('Allergic to allopurinol?');
    expect(patches.filter((patch) => patch.sectionKey === 'subjective')).toHaveLength(0);
    expect(stored.content).toBe('Allergic to allopurinol?');
  });
});
