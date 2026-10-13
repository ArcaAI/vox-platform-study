/**
 * The live note call to TEXT: one retry on a CONCURRENCY_LIMIT refusal, and the real wait reported.
 *
 * TEXT answers 503 `CONCURRENCY_LIMIT` when its provider queue is full — a transient refusal of
 * THIS request, not a verdict about it. The live lane used to fail the whole flush on it, so the
 * clinician's note skipped a turn for a busy second. It now re-posts the same payload ONCE after a
 * short backoff, but only while the flush is still current (not aborted, not superseded). Every
 * other error is handled exactly as before.
 *
 * The flush stats also used to report `textLatencyMs: 0` for a call that failed after a long wait,
 * hiding exactly the slow calls an operator needed to see.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { SectionPatchDto } from '../realtime';

const CID = 'consultation-text-retry';
const TENANT = 'tenant-text-retry';

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
type GenerateAnswer = (call: number) => Promise<{ data: unknown }>;

function buildService(
  cache: ReturnType<typeof cacheMock>,
  answer: GenerateAnswer,
  sections: ReturnType<typeof sectionRepositoryDouble>,
  graphExecutor: boolean,
) {
  const prompts: string[] = [];
  let call = 0;
  const post = vi.fn(async (url: string, body: { prompt?: string; system_prompt?: string }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      prompts.push(`${body?.system_prompt ?? ''}\n\n${body?.prompt ?? ''}`);
      return answer(call++);
    }
    return { data: {} };
  });

  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
        ? { value: graphExecutor, sourceScope: 'tenant' }
        : { value: undefined, sourceScope: 'code-default' },
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

  // The CONCURRENCY_LIMIT backoff, shortened so the suite does not sleep for real.
  (service as unknown as { textConcurrencyRetryMs: number }).textConcurrencyRetryMs = 5;
  return { service, prompts, post };
}

const turn = (body: Record<string, unknown>) => JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

const ok = (): Promise<{ data: unknown }> => Promise.resolve({ data: { summary: turn({ subjective: { addition: 'Cough for three days.' } }) } });

function textRefusal(status: number, errorCode: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { detail: 'refused', error_code: errorCode } },
  });
}

async function flushOnce(answer: GenerateAnswer, graphExecutor: boolean, before?: (service: LiveDocumentationService) => void) {
  const cache = cacheMock();
  const sections = sectionRepositoryDouble();
  const built = buildService(cache, answer, sections, graphExecutor);
  before?.(built.service);
  built.service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  built.service.ingestSegment(CID, { text: 'cough for three days', isFinal: true, segmentId: 's1' });
  await built.service.flush(CID, { force: true });
  const stats = cache.setex.mock.calls
    .map(([, , raw]) => raw as string)
    .filter((raw) => typeof raw === 'string' && raw.includes('"textLatencyMs"'))
    .map((raw) => JSON.parse(raw) as { textLatencyMs: number; textFailed: boolean });
  const final = await built.service.stop(CID, { persistSnapshot: false });
  const generateCalls = built.post.mock.calls.filter(([url]) => String(url).includes('/generate')).length;
  return { final, stats, generateCalls, service: built.service };
}

describe.each([
  ['graph executor', true],
  ['legacy flush', false],
])('postLiveText — one retry on CONCURRENCY_LIMIT (%s)', (_name, graphExecutor) => {
  it('re-posts once after a CONCURRENCY_LIMIT refusal and the note lands', async () => {
    const { final, generateCalls } = await flushOnce(
      (call) => (call === 0 ? Promise.reject(textRefusal(503, 'CONCURRENCY_LIMIT')) : ok()),
      graphExecutor,
    );
    expect(generateCalls).toBe(2);
    expect(final!.runningSummary).toContain('Cough for three days.');
  });

  it('retries only ONCE — a second refusal fails the flush as before', async () => {
    const { final, generateCalls } = await flushOnce(() => Promise.reject(textRefusal(503, 'CONCURRENCY_LIMIT')), graphExecutor);
    expect(generateCalls).toBe(2);
    expect(final!.runningSummary ?? '').not.toContain('Cough');
  });

  it('does not retry any other 503', async () => {
    const { generateCalls } = await flushOnce(() => Promise.reject(textRefusal(503, 'CIRCUIT_OPEN')), graphExecutor);
    expect(generateCalls).toBe(1);
  });

  it('does not retry a flush that was superseded while it waited', async () => {
    let service: LiveDocumentationService | undefined;
    const { generateCalls } = await flushOnce(
      (call) => {
        if (call === 0) {
          // A newer flush took over while this one was refused.
          const session = (service as unknown as { sessions: Map<string, { generation: number }> }).sessions.get(CID)!;
          session.generation += 1;
          return Promise.reject(textRefusal(503, 'CONCURRENCY_LIMIT'));
        }
        return ok();
      },
      graphExecutor,
      (built) => {
        service = built;
      },
    );
    expect(generateCalls).toBe(1);
  });
});

describe.each([
  ['graph executor', true],
  ['legacy flush', false],
])('flush stats — the real TEXT wait (%s)', (_name, graphExecutor) => {
  it('reports how long a FAILED call waited, not 0', async () => {
    const { stats } = await flushOnce(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(textRefusal(500, 'INTERNAL_ERROR')), 60)),
      graphExecutor,
    );
    const failed = stats.find((entry) => entry.textFailed);
    expect(failed).toBeDefined();
    expect(failed!.textLatencyMs).toBeGreaterThanOrEqual(50);
  });
});
