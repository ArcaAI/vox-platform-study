/**
 * TASK-1059 RC-6 — the live flush names a shared-KV exhaustion `kv_exhausted`.
 *
 * `degradeCode` can only tell the two apart when it is told the prompt size and the configured
 * context (`degrade-codes.kv-exhausted.task1059.test.ts`). This suite pins that the LANE tells it:
 * the prompt it actually sent, and LM Studio's governed `lmStudio.serving.contextLength`. It also pins
 * the graph path, which keeps only an error MESSAGE — before this ticket a 422 there degraded as the
 * terminal fallback (`generation_failed`), whatever its code said.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveDocSessionStatsResponse } from '../dto/live-doc-admin.dto';

const CID = 'consultation-1059-kv';
const TENANT = 'tenant-1059-kv';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-10-10T00:00:00.000Z',
});

class HttpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly response?: { status?: number; data?: unknown },
  ) {
    super(message);
    this.name = 'AxiosError';
  }
}

function cacheMock() {
  const stats: LiveDocSessionStatsResponse[] = [];
  return {
    stats,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      if (key.startsWith('live-doc:stats:')) stats.push(JSON.parse(raw) as LiveDocSessionStatsResponse);
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

async function flushWithContextExceeded(options: { graph: boolean; contextLength: number; provider?: string }) {
  const cache = cacheMock();
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      throw new HttpError('Request failed with status code 422', 'ERR_BAD_REQUEST', {
        status: 422,
        data: { detail: { error: 'Context size has been exceeded.', code: 'CONTEXT_WINDOW_EXCEEDED' } },
      });
    }
    return { data: {} };
  });
  const resolveEffective = vi.fn(async (key: string) => {
    if (key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY) return { value: options.graph, sourceScope: 'tenant' };
    if (key === 'lmStudio.serving.contextLength') return { value: options.contextLength, sourceScope: 'system' };
    return { value: undefined, sourceScope: 'code-default' };
  });
  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn((k: string) => (k === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: options.provider ?? 'lm-studio', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    { resolveEffective } as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null, departmentId: null, parentConsultationId: null })) } as never,
  );
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'patient reports a cough for three days', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return cache.stats.at(-1);
}

describe('TASK-1059 RC-6 — the live flush reports kv_exhausted for a prompt that fits', () => {
  it('graph lane: a short prompt against a 32 k context is kv_exhausted, not generation_failed', async () => {
    const stats = await flushWithContextExceeded({ graph: true, contextLength: 32768 });
    expect(stats?.flushFailed).toBe(true);
    expect(stats?.degradeReason).toBe('kv_exhausted');
  });

  it('legacy lane: the same failure is kv_exhausted too', async () => {
    const stats = await flushWithContextExceeded({ graph: false, contextLength: 32768 });
    expect(stats?.degradeReason).toBe('kv_exhausted');
  });

  it('a prompt that is a real share of the context stays context_overflow', async () => {
    const stats = await flushWithContextExceeded({ graph: true, contextLength: 64 });
    expect(stats?.degradeReason).toBe('context_overflow');
  });

  it('a provider whose context the platform does not govern stays context_overflow', async () => {
    const stats = await flushWithContextExceeded({ graph: true, contextLength: 32768, provider: 'azure-openai' });
    expect(stats?.degradeReason).toBe('context_overflow');
  });
});
