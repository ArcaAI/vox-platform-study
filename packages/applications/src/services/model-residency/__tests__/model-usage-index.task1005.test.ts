import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ImplicitLivePathReader } from '../implicit-live-path';
import { MODEL_USAGE_CACHE_MS, ModelUsageIndexReader } from '../model-usage-index';

/**
 * TASK-1005 §13 — the reverse index model → consumers: ONE platform-wide read,
 * cached ≥ 30 s, made of four explicit queries (fallback links, active
 * published agents, active routing policies, tenant names). Never per row.
 */

const T1 = '50000000-0000-0000-0000-000000000001';

function harness() {
  const agents = {
    findAll: vi.fn(async () => [
      { id: 'a1', tenantId: T1, slug: 'rt', name: 'Realtime', task: AgentTask.SPEECH_TO_TEXT, modelId: 'm1' },
      { id: 'a2', tenantId: T1, slug: 'summary', name: 'Summary', task: AgentTask.TEXT_GENERATION, modelId: 'cloud' },
    ]),
  };
  const fallbacks = { findAll: vi.fn(async () => [{ agentId: 'a2', modelId: 'm1' }]) };
  const routing = { findAll: vi.fn(async () => [{ tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.ner', displayName: null, modelId: 'm2' }]) };
  const tenants = {
    findAll: vi.fn(async () => [
      { id: T1, name: 'ArcaAI' },
      { id: SYSTEM_TENANT_ID, name: 'System' },
    ]),
  };
  const livePath = { readLiveAgents: vi.fn(async () => new Set([`${T1}|rt`])) };
  const reader = new ModelUsageIndexReader(agents as never, fallbacks as never, routing as never, tenants as never, livePath as never);
  return { reader, agents, fallbacks, routing, tenants, livePath };
}

const calls = (h: ReturnType<typeof harness>) =>
  [h.agents, h.fallbacks, h.routing, h.tenants].map((r) => r.findAll.mock.calls.length).reduce((a, b) => a + b, 0);

describe('ModelUsageIndexReader (TASK-1005 §13)', () => {
  it('queries explicitly: enabled fallback links and active routing rows by model id, then the ACTIVE PUBLISHED agents, then tenant names', async () => {
    const h = harness();
    const index = await h.reader.read(['m1', 'm2'], 1_000);

    expect(h.fallbacks.findAll).toHaveBeenCalledWith({
      filters: { modelId: { in: ['m1', 'm2'] }, enabled: true, resourceStatus: ResourceStatusType.ENABLED },
    });
    expect(h.routing.findAll).toHaveBeenCalledWith({
      filters: { modelId: { in: ['m1', 'm2'] }, status: 'ACTIVE', enabled: true, killSwitch: false, resourceStatus: ResourceStatusType.ENABLED },
    });
    expect(h.agents.findAll).toHaveBeenCalledWith({
      filters: {
        isActive: true,
        status: WorkflowDefinitionStatus.PUBLISHED,
        resourceStatus: ResourceStatusType.ENABLED,
        OR: [{ modelId: { in: ['m1', 'm2'] } }, { id: { in: ['a2'] } }],
      },
    });
    expect(h.tenants.findAll).toHaveBeenCalledWith({ filters: { id: { in: [T1, SYSTEM_TENANT_ID] } } });

    expect(index.get('m1')).toEqual({
      agentCount: 2,
      tenantCount: 1,
      liveConsultation: true,
      uses: [
        {
          tenantId: T1,
          tenantName: 'ArcaAI',
          agentSlug: 'rt',
          agentName: 'Realtime',
          task: 'SPEECH_TO_TEXT',
          role: 'primary',
          liveConsultation: true,
        },
        {
          tenantId: T1,
          tenantName: 'ArcaAI',
          agentSlug: 'summary',
          agentName: 'Summary',
          task: 'TEXT_GENERATION',
          role: 'fallback',
          liveConsultation: false,
        },
      ],
    });
    expect(index.get('m2')).toMatchObject({
      agentCount: 0,
      tenantCount: 1,
      uses: [{ role: 'routing', agentSlug: null, agentName: 'nlp.ner', task: 'nlp.ner' }],
    });
    expect(index.get('unused')).toEqual({ agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] });
  });

  it(`is cached platform-wide for ${MODEL_USAGE_CACHE_MS / 1000} s (≥ 30 s), and re-reads after it — or when the model set changes`, async () => {
    expect(MODEL_USAGE_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    const h = harness();
    await h.reader.read(['m1', 'm2'], 1_000);
    const first = calls(h);

    await h.reader.read(['m2', 'm1'], 1_000 + MODEL_USAGE_CACHE_MS - 1);
    expect(calls(h)).toBe(first);

    await h.reader.read(['m1', 'm2'], 1_000 + MODEL_USAGE_CACHE_MS);
    expect(calls(h)).toBe(first * 2);

    await h.reader.read(['m1', 'm2', 'm3'], 1_000 + MODEL_USAGE_CACHE_MS);
    expect(calls(h)).toBe(first * 3);
  });

  it('the live-consultation marker follows the live path on every read, even from the cache', async () => {
    const h = harness();
    expect((await h.reader.read(['m1'], 1_000)).get('m1')!.liveConsultation).toBe(true);
    h.livePath.readLiveAgents.mockResolvedValueOnce(new Set());
    expect((await h.reader.read(['m1'], 2_000)).get('m1')!.liveConsultation).toBe(false);
  });

  it('a failed refresh serves the last index (stale beats "nobody uses it"); with nothing cached it throws', async () => {
    const h = harness();
    await h.reader.read(['m1'], 1_000);
    h.agents.findAll.mockRejectedValueOnce(new Error('db down'));
    await expect(h.reader.read(['m1'], 1_000 + MODEL_USAGE_CACHE_MS)).resolves.toMatchObject({});
    expect((await h.reader.read(['m1'], 1_000 + MODEL_USAGE_CACHE_MS)).get('m1')!.agentCount).toBe(2);

    const cold = harness();
    cold.agents.findAll.mockRejectedValueOnce(new Error('db down'));
    await expect(cold.reader.read(['m1'], 1_000)).rejects.toThrow('db down');
  });

  it('an empty model set reads nothing', async () => {
    const h = harness();
    await h.reader.read([], 1_000);
    expect(calls(h)).toBe(0);
  });
});

describe('ImplicitLivePathReader.readLiveAgents (TASK-1005 §13)', () => {
  it('names every assigned agent whose PRIMARY is on the live path — not just the first per model', async () => {
    const assignments = {
      findAll: vi.fn(async () => [
        { tenantId: T1, agentSlug: 'rt', task: AgentTask.SPEECH_TO_TEXT },
        { tenantId: SYSTEM_TENANT_ID, agentSlug: 'rt', task: AgentTask.SPEECH_TO_TEXT },
        { tenantId: T1, agentSlug: 'cloud-summary', task: AgentTask.TEXT_GENERATION },
      ]),
    };
    const agents = {
      findAll: vi.fn(async () => [
        { tenantId: T1, slug: 'rt', task: AgentTask.SPEECH_TO_TEXT, modelId: 'asr' },
        { tenantId: SYSTEM_TENANT_ID, slug: 'rt', task: AgentTask.SPEECH_TO_TEXT, modelId: 'asr' },
        { tenantId: T1, slug: 'cloud-summary', task: AgentTask.TEXT_GENERATION, modelId: 'gpt' },
      ]),
    };
    const aiModels = {
      findAll: vi.fn(async () => [
        { id: 'asr', slug: 'whisper', provider: 'built-in', wireModelId: null },
        { id: 'gpt', slug: 'gpt-4o', provider: 'azure', wireModelId: 'gpt-4o' },
      ]),
    };
    const reader = new ImplicitLivePathReader(assignments as never, agents as never, aiModels as never);

    expect(await reader.readLiveAgents(1_000)).toEqual(new Set([`${T1}|rt`, `${SYSTEM_TENANT_ID}|rt`]));
    // One model on the path, recorded once (unchanged).
    expect(await reader.read(1_000)).toHaveLength(1);
    // Both answers come from one cached load.
    expect(assignments.findAll).toHaveBeenCalledTimes(1);
  });
});
