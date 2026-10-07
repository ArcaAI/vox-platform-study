import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ImplicitLivePathReader, MODEL_CONSUMER_CACHE_MS } from '../implicit-live-path';

/**
 * TASK-1051 F2 / F3 / OD-1 — ONE live-path truth. A model is implicitly PINNED when it is:
 *  - the primary of an ACTIVE PUBLISHED agent assigned to a live task (STT / TEXT_GENERATION);
 *  - a STAGE model (vad, denoise, embedding, …) of such a live ASR agent;
 *  - the model of an ACTIVE routing policy (guardrail judge, NLP);
 *  - the primary of the agent a `core.agent` node of a PUBLISHED workflow with an ENABLED
 *    WorkflowAssignment names.
 * An assignment whose agent has no published version pins nothing.
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
  return { state, repos, livePath };
}

const pinKeys = (rows: Array<{ service: string; modelRef: string }>) => rows.map((r) => `${r.service}|${r.modelRef}`).sort();

describe('ImplicitLivePathReader — one live-path truth (TASK-1051 F2/F3, OD-1)', () => {
  it('pins live primaries, live ASR stage models, active routing models and assigned-workflow node models — nothing else', async () => {
    const { livePath } = scenario();
    const pins = await livePath.read(1_000);

    expect(pinKeys(pins)).toEqual(
      [
        'stt|whisper-ml', // primary of the assigned ASR agent
        'stt|silero-vad', // its enabled VAD stage (SYSTEM row — T1 has no own row)
        'lm-studio|granite-guardian-3', // ACTIVE routing policy (guardrail judge)
        'nlp|fastino/gliner2', // ACTIVE routing policy (NLP)
        'lm-studio|gemma-4', // reached by a core.agent node of an ASSIGNED published workflow
      ].sort(),
    );
    // Each entry says which kind of consumer put it there.
    expect(pins.find((p) => p.modelRef === 'silero-vad')).toMatchObject({
      aiModelId: 'm-vad',
      role: 'pipeline_stage',
      tenantId: T1,
      agentSlug: 'rt',
    });
    expect(pins.find((p) => p.modelRef === 'granite-guardian-3')).toMatchObject({
      aiModelId: 'm-guard',
      role: 'routing',
      tenantId: SYSTEM_TENANT_ID,
    });
    // The node's agent is live through the assigned workflow, so its PRIMARY use is what records the pin.
    expect(pins.find((p) => p.modelRef === 'gemma-4')).toMatchObject({ aiModelId: 'm-gemma', role: 'primary', tenantId: T1, agentSlug: 'summary' });
    expect(pins.find((p) => p.modelRef === 'whisper-ml')).toMatchObject({ aiModelId: 'm-asr', role: 'primary', tenantId: T1, agentSlug: 'rt' });
  });

  it('an assignment whose agent has no PUBLISHED version pins nothing (Sarvam), and a disabled stage ships no model (denoise)', async () => {
    const { livePath } = scenario();
    const pins = await livePath.read(1_000);
    expect(pins.map((p) => p.aiModelId)).not.toContain('m-sarvam');
    expect(pins.map((p) => p.aiModelId)).not.toContain('m-denoise');
  });

  it('an unassigned workflow, a non-live agent stage and a cloud primary are counted elsewhere but never pinned', async () => {
    const { livePath } = scenario();
    const ids = (await livePath.read(1_000)).map((p) => p.aiModelId);
    expect(ids).not.toContain('m-qwen'); // only an UNASSIGNED workflow node + a fallback
    expect(ids).not.toContain('m-emb'); // stage of an agent nobody assigned
    expect(ids).not.toContain('m-vad-t2');
    expect(ids).not.toContain('m-cloud'); // assigned, but no residency service runs it
  });

  it('readLiveAgents names every live agent (assigned, or reached by an assigned workflow) whose PRIMARY is pinned', async () => {
    const { livePath } = scenario();
    // `cloud-summary` is assigned, but its primary is a cloud model no residency service holds.
    expect(await livePath.readLiveAgents(1_000)).toEqual(new Set([`${T1}|rt`, `${T1}|summary`]));
  });

  it('a node pinned to a superseded agent VERSION reaches that version`s primary', async () => {
    const h = scenario();
    h.state.aiModels.push(model({ id: 'm-old', slug: 'gemma-old', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'gemma-3' }));
    h.state.agents.push(
      agent({ id: 'a-sum-v1', tenantId: T1, slug: 'summary', name: 'Summary', task: AgentTask.TEXT_GENERATION, modelId: 'm-old', isActive: false }),
    );
    (h.state.workflows[0]!.compiledConfig as { stages: Array<{ nodes: Row[] }> }).stages[0]!.nodes[0]!.config = {
      label: 'Live summary',
      agentRef: { slug: 'summary', versionNumber: 1 },
    };

    const pins = await h.livePath.read(1_000);
    expect(pins.find((p) => p.aiModelId === 'm-old')).toMatchObject({ service: 'lm-studio', modelRef: 'gemma-3', role: 'workflow_node' });
    expect(pins.map((p) => p.aiModelId)).not.toContain('m-gemma');
    expect(h.repos.agents.findAll).toHaveBeenCalledWith({
      filters: {
        OR: [{ tenantId: T1, slug: 'summary', versionNumber: 1 }],
        status: WorkflowDefinitionStatus.PUBLISHED,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
  });

  it(`is ONE platform-wide read cached ${MODEL_CONSUMER_CACHE_MS / 1000} s: read(), readLiveAgents() and readSnapshot() share it`, async () => {
    const { livePath, repos } = scenario();
    await livePath.read(1_000);
    await livePath.readLiveAgents(1_000 + MODEL_CONSUMER_CACHE_MS - 1);
    await livePath.readSnapshot(1_000 + MODEL_CONSUMER_CACHE_MS - 1);
    expect(repos.assignments.findAll).toHaveBeenCalledTimes(1);
    expect(repos.workflows.findAll).toHaveBeenCalledTimes(1);

    await livePath.read(1_000 + MODEL_CONSUMER_CACHE_MS);
    expect(repos.assignments.findAll).toHaveBeenCalledTimes(2);

    livePath.invalidate();
    await livePath.read(1_000 + MODEL_CONSUMER_CACHE_MS);
    expect(repos.assignments.findAll).toHaveBeenCalledTimes(3);
  });

  it('read() never throws (cold failure = nothing pinned; warm failure = last set); readSnapshot() throws only when cold', async () => {
    const cold = scenario();
    cold.repos.routing.findAll.mockRejectedValueOnce(new Error('db down'));
    expect(await cold.livePath.read(1_000)).toEqual([]);
    cold.repos.routing.findAll.mockRejectedValueOnce(new Error('db down'));
    await expect(cold.livePath.readSnapshot(1_000)).rejects.toThrow('db down');

    const warm = scenario();
    const first = await warm.livePath.read(1_000);
    warm.repos.workflows.findAll.mockRejectedValueOnce(new Error('db down'));
    expect(await warm.livePath.read(1_000 + MODEL_CONSUMER_CACHE_MS)).toEqual(first);
  });
});
