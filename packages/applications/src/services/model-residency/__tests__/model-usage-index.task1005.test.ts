import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ImplicitLivePathReader } from '../implicit-live-path';
import { MODEL_USAGE_CACHE_MS, ModelUsageIndexReader } from '../model-usage-index';

/**
 * TASK-1005 §13 — the reverse index model → consumers: ONE platform-wide read, cached ≥ 30 s,
 * never per row.
 *
 * TASK-1051 changed three expectations here on purpose (F2/F3, OD-1): the index is now a
 * projection of the implicit live-path reader's consumer SNAPSHOT (so its queries are no longer
 * filtered by the requested model ids, and a different id set does not re-read); an ACTIVE
 * routing policy whose model a residency service holds is LIVE; and the usage carries `consumers`.
 */

const T1 = '50000000-0000-0000-0000-000000000001';

function harness() {
  const assignments = { findAll: vi.fn(async () => [{ tenantId: T1, agentSlug: 'rt', task: AgentTask.SPEECH_TO_TEXT }]) };
  const agents = {
    findAll: vi.fn(async () => [
      { id: 'a1', tenantId: T1, slug: 'rt', name: 'Realtime', task: AgentTask.SPEECH_TO_TEXT, modelId: 'm1' },
      { id: 'a2', tenantId: T1, slug: 'summary', name: 'Summary', task: AgentTask.TEXT_GENERATION, modelId: 'cloud' },
    ]),
  };
  const aiModels = {
    findAll: vi.fn(async () => [
      { id: 'm1', tenantId: SYSTEM_TENANT_ID, slug: 'whisper', sourceUri: 's3://w', servedBy: 'stt' },
      { id: 'm2', tenantId: SYSTEM_TENANT_ID, slug: 'ner', sourceUri: 'hub/ner', servedBy: 'nlp' },
      { id: 'cloud', tenantId: SYSTEM_TENANT_ID, slug: 'gpt', sourceUri: 'x', servedBy: 'text', provider: 'azure', wireModelId: 'gpt' },
    ]),
  };
  const fallbacks = { findAll: vi.fn(async () => [{ agentId: 'a2', modelId: 'm1' }]) };
  const routing = { findAll: vi.fn(async () => [{ id: 'r1', tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.ner', displayName: null, modelId: 'm2' }]) };
  const workflows = { findAll: vi.fn(async () => []) };
  const workflowAssignments = { findAll: vi.fn(async () => []) };
  const tenants = {
    findAll: vi.fn(async () => [
      { id: T1, name: 'ArcaAI' },
      { id: SYSTEM_TENANT_ID, name: 'System' },
    ]),
  };
  const livePath = new ImplicitLivePathReader(
    assignments as never,
    agents as never,
    aiModels as never,
    fallbacks as never,
    routing as never,
    workflows as never,
    workflowAssignments as never,
  );
  const reader = new ModelUsageIndexReader(tenants as never, livePath);
  return { reader, livePath, assignments, agents, aiModels, fallbacks, routing, workflows, workflowAssignments, tenants };
}

const calls = (h: ReturnType<typeof harness>) =>
  [h.assignments, h.agents, h.aiModels, h.fallbacks, h.routing, h.workflows, h.workflowAssignments, h.tenants]
    .map((r) => r.findAll.mock.calls.length)
    .reduce((a, b) => a + b, 0);

describe('ModelUsageIndexReader (TASK-1005 §13)', () => {
  it('queries explicitly — ACTIVE PUBLISHED agents, enabled fallback links, active routing rows, the named models, tenant names — and attributes primary / fallback / routing', async () => {
    const h = harness();
    const index = await h.reader.read(['m1', 'm2'], 1_000);

    expect(h.agents.findAll).toHaveBeenCalledWith({
      filters: { isActive: true, status: WorkflowDefinitionStatus.PUBLISHED, resourceStatus: ResourceStatusType.ENABLED },
    });
    expect(h.fallbacks.findAll).toHaveBeenCalledWith({ filters: { enabled: true, resourceStatus: ResourceStatusType.ENABLED } });
    expect(h.routing.findAll).toHaveBeenCalledWith({
      filters: { status: 'ACTIVE', enabled: true, killSwitch: false, resourceStatus: ResourceStatusType.ENABLED },
    });
    expect(h.aiModels.findAll).toHaveBeenCalledWith({ filters: { OR: [{ id: { in: ['m1', 'cloud', 'm2'] } }] } });
    expect(h.tenants.findAll).toHaveBeenCalledWith({ filters: { id: { in: [T1, SYSTEM_TENANT_ID] } } });

    expect(index.get('m1')).toEqual({
      agentCount: 2,
      tenantCount: 1,
      liveConsultation: true,
      consumers: { agents: 1, fallbacks: 1, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
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
    // TASK-1051 OD-1: an ACTIVE routing policy is on the live path, and nlp holds its model.
    expect(index.get('m2')).toMatchObject({
      agentCount: 0,
      tenantCount: 1,
      liveConsultation: true,
      consumers: { routingPolicies: 1 },
      uses: [{ role: 'routing', agentSlug: null, agentName: 'nlp.ner', task: 'nlp.ner', liveConsultation: true }],
    });
    expect(index.get('unused')).toEqual({
      agentCount: 0,
      tenantCount: 0,
      liveConsultation: false,
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
      uses: [],
    });
  });

  it(`is cached platform-wide for ${MODEL_USAGE_CACHE_MS / 1000} s (≥ 30 s) for EVERY model set, and re-reads after it`, async () => {
    expect(MODEL_USAGE_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    const h = harness();
    await h.reader.read(['m1', 'm2'], 1_000);
    const first = calls(h);

    await h.reader.read(['m2', 'm1'], 1_000 + MODEL_USAGE_CACHE_MS - 1);
    // TASK-1051: the snapshot covers every model, so a new id set is served from it too.
    await h.reader.read(['m1', 'm2', 'm3'], 1_000 + MODEL_USAGE_CACHE_MS - 1);
    expect(calls(h)).toBe(first);

    await h.reader.read(['m1', 'm2'], 1_000 + MODEL_USAGE_CACHE_MS);
    expect(calls(h)).toBe(first * 2);
  });

  it('the live-consultation marker follows the live path: the same snapshot drives both', async () => {
    const h = harness();
    expect((await h.reader.read(['m1'], 1_000)).get('m1')!.liveConsultation).toBe(true);
    h.assignments.findAll.mockResolvedValueOnce([]);
    h.livePath.invalidate();
    expect((await h.reader.read(['m1'], 2_000)).get('m1')!.liveConsultation).toBe(false);
    expect(await h.livePath.read(2_000)).toEqual([
      // only the routing model stays pinned
      expect.objectContaining({ service: 'nlp', modelRef: 'hub/ner', aiModelId: 'm2', role: 'routing' }),
    ]);
  });

  it('a failed refresh serves the last index (stale beats "nobody uses it"); with nothing cached it throws', async () => {
    const h = harness();
    await h.reader.read(['m1'], 1_000);
    h.agents.findAll.mockRejectedValueOnce(new Error('db down'));
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
        { id: 'a1', tenantId: T1, slug: 'rt', task: AgentTask.SPEECH_TO_TEXT, modelId: 'asr' },
        { id: 'a2', tenantId: SYSTEM_TENANT_ID, slug: 'rt', task: AgentTask.SPEECH_TO_TEXT, modelId: 'asr' },
        { id: 'a3', tenantId: T1, slug: 'cloud-summary', task: AgentTask.TEXT_GENERATION, modelId: 'gpt' },
      ]),
    };
    const aiModels = {
      findAll: vi.fn(async () => [
        { id: 'asr', tenantId: SYSTEM_TENANT_ID, slug: 'whisper', sourceUri: 's3://w', servedBy: 'stt', provider: 'built-in', wireModelId: null },
        { id: 'gpt', tenantId: SYSTEM_TENANT_ID, slug: 'gpt-4o', sourceUri: 'x', servedBy: 'text', provider: 'azure', wireModelId: 'gpt-4o' },
      ]),
    };
    const none = { findAll: vi.fn(async () => []) };
    const reader = new ImplicitLivePathReader(
      assignments as never,
      agents as never,
      aiModels as never,
      none as never,
      none as never,
      none as never,
      none as never,
    );

    expect(await reader.readLiveAgents(1_000)).toEqual(new Set([`${T1}|rt`, `${SYSTEM_TENANT_ID}|rt`]));
    // One model on the path, recorded once (unchanged).
    expect(await reader.read(1_000)).toHaveLength(1);
    // Both answers come from one cached load.
    expect(assignments.findAll).toHaveBeenCalledTimes(1);
  });
});
