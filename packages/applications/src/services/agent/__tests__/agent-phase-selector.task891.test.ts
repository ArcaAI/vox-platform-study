/**
 * TASK-891 — the selector seam through the two agent resolvers.
 *
 * `HarnessPolicyService` turns the routing task into a `phase:<task>` tag, but the tag has to
 * REACH `AgentAssignmentService.resolve` to select anything, and it crosses two services to get
 * there: `TextAgentResolverService` (which also CACHES) and `AgentResolverService`.
 *
 * Two properties matter here and neither is obvious:
 *
 *  1. **A call carrying no tags must be byte-identical to today's call.** Every other caller of
 *     these resolvers — the ASR seam, the prompt test bench, the `core.agent` node — supplies
 *     none, and their tests assert the exact object. So `selectorTags` is OMITTED, not passed
 *     empty, when there is nothing to say.
 *  2. **The tags must be part of the spec cache key.** `TextAgentResolverService` memoises a
 *     resolved spec for 15 s keyed by `tenant::department::slug`. The live loop flushes every
 *     few seconds, so a key that ignored the phase would let the FIRST flush's spec serve the
 *     finalize call (and vice versa) for the rest of the window — the very cross-tier bleed this
 *     ticket exists to remove, reintroduced by a cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { AgentResolverService } from '../agent-resolver.service';
import { TextAgentResolverService } from '../text-agent-resolver.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

// ---------------------------------------------------------------------------------------------
// AgentResolverService — the tag reaches the cascade
// ---------------------------------------------------------------------------------------------

const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const aiModelRepository = { findById: vi.fn(), findBySlug: vi.fn() };
const assignments = { resolve: vi.fn() };

const modelRow = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  sourceUri: 'gemma-4-e2b-it-qat',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'GGUF',
  computeType: null,
  provider: 'lm-studio',
  wireModelId: 'gemma-4-e2b-it-qat',
  ...over,
});

const publishedRow = (over: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  tenantId: TENANT,
  slug: 'platform-summarization',
  versionNumber: 1,
  task: AgentTask.TEXT_GENERATION,
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
    protocols: ['http'],
  },
  ...over,
});

const agentResolver = () =>
  new AgentResolverService(agentRepository as never, fallbackRepository as never, aiModelRepository as never, assignments as never);

describe('AgentResolverService — selectorTags reach the assignment cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiModelRepository.findById.mockResolvedValue(modelRow());
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(publishedRow());
    assignments.resolve.mockResolvedValue({ agentSlug: 'platform-summarization', source: 'tenant', selector: [] });
  });

  it('forwards them as the cascade`s fourth argument, beside (never instead of) the department', async () => {
    await agentResolver().resolve({
      tenantId: TENANT,
      task: AgentTask.TEXT_GENERATION,
      departmentId: 'dept-1',
      selectorTags: ['phase:live'],
    });
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, 'dept-1', ['phase:live']);
  });

  it('a call with NO tags reaches the cascade exactly as it did before — three arguments, not an empty fourth', async () => {
    await agentResolver().resolve({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION, departmentId: 'dept-1' });
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, 'dept-1');
  });

  it('an EXPLICIT slug still bypasses the cascade — the workflow named the agent, so no selector applies', async () => {
    await agentResolver().resolve({ tenantId: TENANT, agentSlug: 'platform-summarization', selectorTags: ['phase:live'] });
    expect(assignments.resolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// TextAgentResolverService — forwarding, and the cache key
// ---------------------------------------------------------------------------------------------

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel =>
  ({
    role: 'primary',
    slug: 'lms-gemma-4-e2b-it-qat',
    sourceUri: 'gemma-4-e2b-it-qat',
    wireModelId: 'gemma-4-e2b-it-qat',
    sourceRevision: null,
    localPath: null,
    checksum: null,
    format: 'GGUF',
    computeType: null,
    provider: 'lm-studio',
    tenantId: SYSTEM_TENANT_ID,
    ...over,
  }) as ResolvedAgentModel;

const resolvedAgent = (slug: string, wireModelId: string): ResolvedAgent =>
  ({
    agentId: `id-${slug}`,
    agentVersionId: `id-${slug}`,
    slug,
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: { generation: { temperature: 0.2, maxTokens: 2048 }, responseFormat: 'text' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
      protocols: ['http'],
    },
    models: [model({ wireModelId })],
  }) as ResolvedAgent;

const agents = { resolve: vi.fn() };
const textResolver = () => new TextAgentResolverService(agents as never, assignments as never);

describe('TextAgentResolverService — selectorTags forwarding and cache identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The cascade stands in for the split assignment table: `phase:live` selects the live agent.
    agents.resolve.mockImplementation(async (input: { selectorTags?: readonly string[] }) =>
      input.selectorTags?.includes('phase:live')
        ? resolvedAgent('platform-summarization-live', 'gemma-live')
        : resolvedAgent('platform-summarization', 'gemma-finalize'),
    );
  });

  it('forwards the tags to the agent resolver', async () => {
    const spec = await textResolver().resolve({ tenantId: TENANT, selectorTags: ['phase:live'] });
    expect(agents.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION, selectorTags: ['phase:live'] }),
    );
    expect(spec.agent.slug).toBe('platform-summarization-live');
  });

  it('a call with NO tags is byte-identical to today`s — the key is absent, not empty', async () => {
    await textResolver().resolve({ tenantId: TENANT, departmentId: 'dept-1' });
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: null, departmentId: 'dept-1' });
  });

  it('DIFFERENT phases do not share a cache entry — the live spec must never serve the finalize call', async () => {
    const service = textResolver();
    const live = await service.resolve({ tenantId: TENANT, selectorTags: ['phase:live'] });
    const finalize = await service.resolve({ tenantId: TENANT, selectorTags: ['phase:finalize'] });
    expect(live.primary.model).toBe('gemma-live');
    expect(finalize.primary.model).toBe('gemma-finalize');
    expect(agents.resolve).toHaveBeenCalledTimes(2);
  });

  it('the SAME phase still shares one entry, and tag ORDER does not fork the cache', async () => {
    const service = textResolver();
    await service.resolve({ tenantId: TENANT, selectorTags: ['phase:live', 'specialty:cardiology'] });
    await service.resolve({ tenantId: TENANT, selectorTags: ['specialty:cardiology', 'phase:live'] });
    expect(agents.resolve).toHaveBeenCalledTimes(1);
  });

  it('an untagged call does not collide with a tagged one either', async () => {
    const service = textResolver();
    await service.resolve({ tenantId: TENANT });
    await service.resolve({ tenantId: TENANT, selectorTags: ['phase:live'] });
    expect(agents.resolve).toHaveBeenCalledTimes(2);
  });
});
