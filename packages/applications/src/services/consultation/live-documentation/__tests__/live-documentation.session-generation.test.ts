/**
 * FIELD DEFECT (Lane E runtime verification, 2026-08-29) — a SECOND recording
 * session on the same consultation could never publish a document section.
 *
 * ## What was observed
 *
 * On a live stack with the graph executor enabled, a consultation that had
 * already been recorded once produced, on its next session:
 *
 *   Section patch refused … {"documentKey":"soap_note","sectionKey":"subjective","reason":"stale-generation"}
 *   Section patch refused … {"sectionKey":"objective","reason":"stale-generation"}
 *   Section patch refused … {"sectionKey":"assessment","reason":"stale-generation"}
 *   Section patch refused … {"sectionKey":"plan","reason":"stale-generation"}
 *
 * for a flush logged as `"generation":1,"flushCount":1` — a brand-new session.
 * No row was written, no `section.patch` was published, and the clinician was
 * left watching the "Waiting for the first live summary" skeleton indefinitely.
 *
 * ## Why
 *
 * `DocumentSectionStore.lastGeneration` is the flush staleness watermark, keyed
 * by section address alone. `LiveDocumentationService` memoizes ONE store per
 * process (`this.sectionStore ??= new DocumentSectionStore(...)`), so the
 * watermark outlives the session that set it — while `generation` restarts at 1
 * for every new session. Once session 1 reached generation N, every write of
 * session 2 satisfied `input.generation < seen` and was refused.
 *
 * `DocumentSectionStore.forget()` was written for exactly this ("Drop a finished
 * session's staleness bookkeeping") and had ZERO production callers.
 *
 * The fix resets the watermark when a session STARTS rather than when it stops:
 * a session that crashed, lost its owner lock, or was torn down by the substrate
 * gate never reaches `stop()`, and it is precisely those sessions whose stale
 * watermark would poison the next one.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';

const CID = 'consultation-gen-001';
const TENANT = 'tenant-gen-001';
const NOTE = 'Subjective: patient reports cough\nObjective:\nAssessment:\nPlan:';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-08-29T00:00:00.000Z',
});

function httpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE } });
    return Promise.resolve({ data: {} });
  });
  return { axiosRef: { post }, post };
}

function cacheMock() {
  return {
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
}

/** Minimal in-memory DocumentSection repository — enough for the store to write. */
function sectionRepositoryDouble() {
  const rows = new Map<string, { id: string; documentKey: string; sectionKey: string; version: number }>();
  const writes: string[] = [];
  const key = (documentKey: string, sectionKey: string) => `${documentKey}::${sectionKey}`;
  return {
    rows,
    writes,
    findSection: vi.fn(async (_t: string, _c: string, documentKey: string, sectionKey: string) => rows.get(key(documentKey, sectionKey)) ?? null),
    create: vi.fn(async (entity: { documentKey: string; sectionKey: string }) => {
      rows.set(key(entity.documentKey, entity.sectionKey), entity as never);
      writes.push(`create:${entity.sectionKey}`);
      return entity;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: { documentKey: string; sectionKey: string }) => {
      rows.set(key(entity.documentKey, entity.sectionKey), entity as never);
      writes.push(`update:${entity.sectionKey}`);
      return entity;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

function buildService(sectionRepository: ReturnType<typeof sectionRepositoryDouble>) {
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  return new LiveDocumentationService(
    httpMock() as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    effectiveSettings as never,
    { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
    undefined, // workflowAssignments
    undefined, // workflowDefinitionRepository
    sectionRepository as never,
  );
}

/** One full session: start, feed a final segment, flush `count` times. */
async function runSession(service: LiveDocumentationService, count: number): Promise<void> {
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });
  for (let i = 0; i < count; i += 1) await service.flush(CID);
}

describe('the flush staleness watermark must not outlive its session', () => {
  it('a SECOND recording session still writes sections (the generation counter restarts at 1)', async () => {
    const sectionRepository = sectionRepositoryDouble();
    const service = buildService(sectionRepository);

    // Session 1 runs to generation 2 and writes its sections.
    await runSession(service, 2);
    expect(sectionRepository.writes.length).toBeGreaterThan(0);
    await service.stop(CID, { persistSnapshot: false });

    // Session 2 on the SAME consultation — `generation` restarts at 1.
    sectionRepository.writes.length = 0;
    await runSession(service, 1);

    expect(
      sectionRepository.writes,
      'the second session wrote no section: its generation-1 flush was refused as `stale-generation` against the previous session’s watermark',
    ).not.toEqual([]);
  });
});
