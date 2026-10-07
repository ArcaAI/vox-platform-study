import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ImplicitLivePathReader, MODEL_CONSUMER_CACHE_MS } from '../implicit-live-path';
import { MODEL_USAGE_CACHE_MS, ModelUsageIndexReader } from '../model-usage-index';

/**
 * TASK-1051 F2 / F3 / OD-1 — the reverse index counts EVERY kind of consumer (primary, fallback,
 * routing policy, ASR pipeline stage, workflow `core.agent` node), and its `liveConsultation`
 * marker is computed from the SAME snapshot as the implicit live-path pin set, so the two can
 * never disagree.
 */

const T1 = '50000000-0000-0000-0000-000000000001';
const T2 = '50000000-0000-0000-0000-000000000002';

type Row = Record<string, unknown>;

/** A tiny evaluator for the filter shapes the reader sends (equality, `in`, `not`, `OR`). */
function matches(row: Row, filters: Row | undefined): boolean {
  if (!filters) return true;
  return Object.entries(filters).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((alt) => matches(row, alt));
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(row[key]);
      if ('not' in c) return row[key] !== c.not;
    }
    return row[key] === cond;
  });
}

function repo(rows: () => Row[]) {
  return { findAll: vi.fn(async (props: { filters?: Row } = {}) => rows().filter((r) => matches(r, props.filters))) };
}

const PUBLISHED = { status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, resourceStatus: ResourceStatusType.ENABLED };

function agent(over: Row): Row {
  return { ...PUBLISHED, versionNumber: 1, compiledConfig: null, parameters: null, ...over };
}

function model(over: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    deploymentKind: 'SELF_HOSTED',
    provider: null,
    wireModelId: null,
    sourceUri: `s3://hope-models/${String(over.slug)}`,
    ...over,
  };
}

function scenario() {
  const state = {
    aiModels: [
      model({ id: 'm-asr', slug: 'whisper-ml', servedBy: 'stt' }),
      model({ id: 'm-vad', slug: 'silero-vad', servedBy: 'stt' }),
      model({ id: 'm-denoise', slug: 'rnnoise', servedBy: 'stt' }),
      model({ id: 'm-emb', slug: 'ecapa', servedBy: 'stt' }),
      // T2's OWN row under the same slug — a T2 agent naming `silero-vad` resolves here first.
      model({ id: 'm-vad-t2', tenantId: T2, slug: 'silero-vad', servedBy: 'stt' }),
      model({ id: 'm-guard', slug: 'granite-guardian', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'granite-guardian-3' }),
      model({ id: 'm-gliner', slug: 'gliner2', servedBy: 'nlp', sourceUri: 'fastino/gliner2' }),
      model({ id: 'm-gemma', slug: 'gemma', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'gemma-4' }),
      model({ id: 'm-qwen', slug: 'qwen', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'qwen-3' }),
      model({ id: 'm-sarvam', slug: 'sarvam', servedBy: 'stt' }),
      model({ id: 'm-cloud', slug: 'gpt-4o', servedBy: 'text', deploymentKind: 'CLOUD', provider: 'azure', wireModelId: 'gpt-4o' }),
    ] as Row[],
    agents: [
      agent({
        id: 'a-rt',
        tenantId: T1,
        slug: 'rt',
        name: 'Realtime',
        task: AgentTask.SPEECH_TO_TEXT,
        modelId: 'm-asr',
        compiledConfig: {
          parameters: {
            audioFrontEnd: { vad: { enabled: true, modelSlug: 'silero-vad' }, denoise: { enabled: false, modelSlug: 'rnnoise' } },
          },
        },
      }),
      agent({
        id: 'a-rad',
        tenantId: T2,
        slug: 'rad-asr',
        name: 'Radiology ASR',
        task: AgentTask.SPEECH_TO_TEXT,
        modelId: 'm-asr',
        // No compiledConfig: the authored parameters are read instead.
        parameters: {
          audioFrontEnd: {
            vad: { enabled: true, modelSlug: 'silero-vad' },
            diarization: { enabled: true, embeddingModelSlug: 'ecapa' },
          },
        },
      }),
      agent({ id: 'a-sum', tenantId: T1, slug: 'summary', name: 'Summary', task: AgentTask.TEXT_GENERATION, modelId: 'm-gemma', versionNumber: 2 }),
      agent({ id: 'a-qwen', tenantId: T2, slug: 'qwen-agent', name: 'Qwen agent', task: AgentTask.TEXT_GENERATION, modelId: 'm-qwen' }),
      agent({ id: 'a-cloud', tenantId: T1, slug: 'cloud-summary', name: 'Cloud', task: AgentTask.TEXT_GENERATION, modelId: 'm-cloud' }),
      // Only a DRAFT: the assignment naming it pins nothing.
      agent({
        id: 'a-sarvam',
        tenantId: T1,
        slug: 'sarvam-rt',
        name: 'Sarvam',
        task: AgentTask.SPEECH_TO_TEXT,
        modelId: 'm-sarvam',
        status: 'DRAFT',
      }),
    ] as Row[],
    assignments: [
      { tenantId: T1, agentSlug: 'rt', task: AgentTask.SPEECH_TO_TEXT, resourceStatus: ResourceStatusType.ENABLED },
      { tenantId: T1, agentSlug: 'sarvam-rt', task: AgentTask.SPEECH_TO_TEXT, resourceStatus: ResourceStatusType.ENABLED },
      { tenantId: T1, agentSlug: 'cloud-summary', task: AgentTask.TEXT_GENERATION, resourceStatus: ResourceStatusType.ENABLED },
    ] as Row[],
    fallbacks: [
      { id: 'f1', tenantId: T1, agentId: 'a-sum', modelId: 'm-qwen', priority: 1, enabled: true, resourceStatus: ResourceStatusType.ENABLED },
    ] as Row[],
    routing: [
      {
        id: 'r-guard',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'guardrail.judge',
        displayName: 'Guardrail judge',
        modelId: 'm-guard',
        status: 'ACTIVE',
        enabled: true,
        killSwitch: false,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      {
        id: 'r-gliner',
        tenantId: T1,
        taskKey: 'nlp.ner',
        displayName: null,
        modelId: 'm-gliner',
        status: 'ACTIVE',
        enabled: true,
        killSwitch: false,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      // A DRAFT policy is not a consumer.
      {
        id: 'r-draft',
        tenantId: T1,
        taskKey: 'guardrail.safety',
        displayName: null,
        modelId: 'm-sarvam',
        status: 'DRAFT',
        enabled: true,
        killSwitch: false,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    ] as Row[],
    workflows: [
      {
        id: 'wf-1',
        tenantId: T1,
        slug: 'alaas-flow',
        name: 'ALaaS consult',
        ...PUBLISHED,
        graph: { nodes: [] },
        compiledConfig: {
          stages: [{ nodes: [{ nodeId: 'n_summary', type: 'core.agent', config: { label: 'Live summary', agentRef: { slug: 'summary' } } }] }],
        },
      },
      {
        id: 'wf-2',
        tenantId: T2,
        slug: 'draft-flow',
        name: 'Draft flow',
        ...PUBLISHED,
        graph: { nodes: [{ id: 'n1', type: 'core.agent', config: { agentRef: { slug: 'qwen-agent' } } }] },
        compiledConfig: null,
      },
    ] as Row[],
    workflowAssignments: [{ tenantId: T1, workflowDefinitionSlug: 'alaas-flow', resourceStatus: ResourceStatusType.ENABLED }] as Row[],
    tenants: [
      { id: SYSTEM_TENANT_ID, name: 'System' },
      { id: T1, name: 'ArcaAI' },
      { id: T2, name: 'Global' },
    ] as Row[],
  };
  const repos = {
    assignments: repo(() => state.assignments),
    agents: repo(() => state.agents),
    aiModels: repo(() => state.aiModels),
    fallbacks: repo(() => state.fallbacks),
    routing: repo(() => state.routing),
    workflows: repo(() => state.workflows),
    workflowAssignments: repo(() => state.workflowAssignments),
    tenants: repo(() => state.tenants),
  };
  const livePath = new ImplicitLivePathReader(
    repos.assignments as never,
    repos.agents as never,
    repos.aiModels as never,
    repos.fallbacks as never,
    repos.routing as never,
    repos.workflows as never,
    repos.workflowAssignments as never,
  );
  const usage = new ModelUsageIndexReader(repos.tenants as never, livePath);
  return { state, repos, livePath, usage };
}

const ALL_IDS = () => scenario().state.aiModels.map((m) => String(m.id));

describe('ModelUsageIndexReader — every consumer kind, counted (TASK-1051 F2)', () => {
  it('a routing-only model (guardrail judge) is counted as a routing policy and is live', async () => {
    const { usage } = scenario();
    const index = await usage.read(ALL_IDS(), 1_000);
    expect(index.get('m-guard')).toEqual({
      agentCount: 0,
      tenantCount: 1,
      liveConsultation: true,
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 1, pipelineStages: 0, workflowNodes: 0 },
      uses: [
        {
          tenantId: SYSTEM_TENANT_ID,
          tenantName: 'System',
          agentSlug: null,
          agentName: 'Guardrail judge',
          task: 'guardrail.judge',
          role: 'routing',
          liveConsultation: true,
        },
      ],
    });
    expect(index.get('m-gliner')).toMatchObject({
      liveConsultation: true,
      consumers: { routingPolicies: 1 },
      uses: [{ role: 'routing', agentName: 'nlp.ner', task: 'nlp.ner', tenantName: 'ArcaAI' }],
    });
  });

  it('the VAD stage of a live ASR agent is a pipeline-stage consumer, live; a stage of an unassigned agent is counted, not live', async () => {
    const { usage } = scenario();
    const index = await usage.read(ALL_IDS(), 1_000);
    expect(index.get('m-vad')).toEqual({
      agentCount: 0,
      tenantCount: 1,
      liveConsultation: true,
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 1, workflowNodes: 0 },
      uses: [
        {
          tenantId: T1,
          tenantName: 'ArcaAI',
          agentSlug: 'rt',
          agentName: 'Realtime',
          task: 'SPEECH_TO_TEXT · vad',
          role: 'pipeline_stage',
          liveConsultation: true,
        },
      ],
    });
    // T2's agent names the same slug but T2 owns a row under it — that row is the one it uses.
    expect(index.get('m-vad-t2')).toMatchObject({ liveConsultation: false, consumers: { pipelineStages: 1 } });
    expect(index.get('m-emb')).toMatchObject({
      liveConsultation: false,
      consumers: { pipelineStages: 1 },
      uses: [{ agentSlug: 'rad-asr', task: 'SPEECH_TO_TEXT · embedding', role: 'pipeline_stage', tenantName: 'Global' }],
    });
    // A stage the agent switched off ships no model and so has no consumer.
    expect(index.get('m-denoise').uses).toEqual([]);
  });

  it('a workflow node model is counted (and live only when the workflow is assigned)', async () => {
    const { usage } = scenario();
    const index = await usage.read(ALL_IDS(), 1_000);

    const gemma = index.get('m-gemma');
    expect(gemma).toMatchObject({
      agentCount: 1,
      tenantCount: 1,
      liveConsultation: true,
      consumers: { agents: 1, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 1 },
    });
    expect(gemma.uses).toEqual(
      expect.arrayContaining([
        {
          tenantId: T1,
          tenantName: 'ArcaAI',
          agentSlug: 'summary',
          agentName: 'Summary',
          task: 'TEXT_GENERATION',
          role: 'primary',
          liveConsultation: true,
        },
        {
          tenantId: T1,
          tenantName: 'ArcaAI',
          agentSlug: 'summary',
          agentName: 'ALaaS consult › Live summary',
          task: 'TEXT_GENERATION',
          role: 'workflow_node',
          liveConsultation: true,
        },
      ]),
    );

    const qwen = index.get('m-qwen');
    expect(qwen).toMatchObject({
      agentCount: 2, // primary of qwen-agent + fallback of summary
      tenantCount: 2,
      liveConsultation: false,
      consumers: { agents: 1, fallbacks: 1, routingPolicies: 0, pipelineStages: 0, workflowNodes: 1 },
    });
    expect(qwen.uses.find((u) => u.role === 'workflow_node')).toMatchObject({ agentName: 'Draft flow › n1', liveConsultation: false });
  });

  it('agentCount keeps its meaning (distinct agents among primary + fallback); tenantCount spans every use', async () => {
    const { usage } = scenario();
    const asr = (await usage.read(ALL_IDS(), 1_000)).get('m-asr');
    expect(asr).toMatchObject({
      agentCount: 2,
      tenantCount: 2,
      liveConsultation: true,
      consumers: { agents: 2, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
    });
    expect(asr.uses.find((u) => u.agentSlug === 'rad-asr')).toMatchObject({ role: 'primary', liveConsultation: false });
  });

  it('an assignment whose agent has no published version is no consumer at all; a DRAFT routing policy neither', async () => {
    const { usage } = scenario();
    expect((await usage.read(ALL_IDS(), 1_000)).get('m-sarvam')).toEqual({
      agentCount: 0,
      tenantCount: 0,
      liveConsultation: false,
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
      uses: [],
    });
  });

  it('usage.liveConsultation <=> membership of the implicit live-path pin set, for every model', async () => {
    const { usage, livePath } = scenario();
    const index = await usage.read(ALL_IDS(), 1_000);
    const pinned = new Set((await livePath.read(1_000)).map((p) => p.aiModelId));
    for (const id of ALL_IDS()) expect([id, index.get(id).liveConsultation]).toEqual([id, pinned.has(id)]);
  });

  it('shares the live-path snapshot: one load serves both readers; the usage cache is the same platform-wide window', async () => {
    expect(MODEL_USAGE_CACHE_MS).toBe(MODEL_CONSUMER_CACHE_MS);
    expect(MODEL_USAGE_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    const { usage, livePath, repos } = scenario();
    await livePath.read(1_000);
    await usage.read(ALL_IDS(), 1_000 + 5);
    expect(repos.assignments.findAll).toHaveBeenCalledTimes(1);
    expect(repos.agents.findAll).toHaveBeenCalledTimes(1);
    expect(repos.tenants.findAll).toHaveBeenCalledTimes(1);
    // A different model set does not re-read: the snapshot is platform-wide, not per id set.
    await usage.read(['m-asr'], 1_000 + 10);
    expect(repos.agents.findAll).toHaveBeenCalledTimes(1);
    expect(repos.tenants.findAll).toHaveBeenCalledTimes(1);
  });
});
