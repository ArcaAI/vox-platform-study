/**
 * TASK-891 (owner decision: "separate live and finalize agents") — the routing TASK is a real
 * SELECTOR again.
 *
 * ## The defect this pins
 *
 * `resolveTextSelection(tenantId, task, departmentId)` declared a `task` of `'live' | 'finalize'
 * | 'test'` and used it ONLY inside error-message strings: the body called
 * `textAgents.resolve({ tenantId, departmentId })` with no task at all. So the live running-note
 * flush and the finalize synthesis resolved the SAME agent, and one agent cannot express two
 * reasoning postures — measured on `gemma-4-e2b-it-qat`, reasoning unset costs 5168 ms / 184
 * reasoning tokens against a realtime budget where `minimal` costs 1237 ms / 30.
 *
 * ## The mechanism, reused rather than invented
 *
 * TASK-884's `AgentAssignment.selectorKey`. The task becomes ONE reserved tag, `phase:<task>`,
 * and `AgentAssignmentService.resolve` already does the rest: within a tier, rows whose selector
 * is a SUBSET of the request's tags, most specific first, the unqualified row last.
 *
 * ## Why the tests below build the REAL cascade instead of stubbing it
 *
 * The load-bearing claim is a NEGATIVE one — a tenant that has authored nothing must resolve
 * exactly what it resolves today, and `resolveTextSelection` is `failMode: closed`, so a
 * regression here is a THROW on a clinical path, not a degraded answer. A stubbed resolver
 * cannot show that: it answers whatever it was told to. So `assignmentStore()` below implements
 * the tier walk with the SAME `agentTagsSatisfy` / `canonicalAgentTags` the real service uses,
 * over a real row table, and the whole chain (`HarnessPolicyService` → `TextAgentResolverService`
 * → `AgentResolverService` → the cascade) is exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { agentTagsSatisfy, canonicalAgentTags } from '@arcaai/workflow-contract';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { TextAgentResolverService } from '../../agent/text-agent-resolver.service';
import { HarnessPolicyService, TEXT_PHASE_TAG_KEY, textPhaseSelectorTags } from '../harness-policy.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

/** One SYSTEM-tenant assignment row, in the shape `findAllForScope` returns. */
interface Row {
  agentSlug: string;
  selectorKey: string;
}

/**
 * The REAL tier walk of `AgentAssignmentService.resolve`, over a row table: subset match,
 * most-specific-first, unqualified last. Only the TENANT tier — these tests never set a
 * department, and the department tier's ordering is TASK-884's own coverage.
 */
function assignmentStore(rows: Row[]) {
  const resolve = vi.fn(async (_tenantId: string, _task: AgentTask, _departmentId?: string | null, selectorTags: readonly string[] = []) => {
    const requestTags = canonicalAgentTags([...selectorTags]);
    const match = rows
      .map((row) => ({ row, selector: row.selectorKey ? row.selectorKey.split(',') : [] }))
      .filter(({ selector }) => agentTagsSatisfy(requestTags, selector))
      .sort((a, b) => b.selector.length - a.selector.length || a.row.selectorKey.localeCompare(b.row.selectorKey))[0];
    return match
      ? { agentSlug: match.row.agentSlug, source: 'tenant' as const, selector: match.selector }
      : { agentSlug: null, source: 'unassigned' as const, selector: [] };
  });
  return { resolve };
}

/**
 * The generation block both fixture agents author. `resolveTextSelection` carries it out with the
 * selection (TASK-891 — the live tier's reasoning posture has to reach the wire, and it was being
 * resolved and discarded), so it appears in every answer below. Which AGENT answered is still
 * named by the model id, exactly as before.
 */
const GENERATION = { temperature: 0.2, maxTokens: 2048 };

/** Two agents that differ only in the model they bind, so `{ provider, model }` names WHICH one answered. */
const AGENTS: Record<string, { modelId: string; wireModelId: string }> = {
  'platform-summarization': { modelId: 'm-finalize', wireModelId: 'gemma-4-e2b-it-qat' },
  'platform-summarization-live': { modelId: 'm-live', wireModelId: 'gemma-4-e2b-it-qat-live' },
};

const agentRepository = {
  findPublishedActiveBySlug: vi.fn(async (tenantId: string, slug: string) => {
    const spec = AGENTS[slug];
    if (!spec) return null;
    return {
      id: `agent-${slug}`,
      tenantId,
      slug,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: {
        task: 'TEXT_GENERATION',
        service: 'llm',
        model: { id: spec.modelId, slug: spec.modelId, provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
        fallbacks: [],
        instruction: null,
        resolvedPrompt: null,
        parameters: { generation: GENERATION, responseFormat: 'text' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tools: [],
      },
    };
  }),
};

const aiModelRepository = {
  findById: vi.fn(async (id: string) => ({
    id,
    tenantId: SYSTEM_TENANT_ID,
    slug: id,
    sourceUri: id,
    sourceRevision: null,
    localPath: null,
    checksum: null,
    format: 'GGUF',
    computeType: null,
    provider: 'lm-studio',
    wireModelId: Object.values(AGENTS).find((spec) => spec.modelId === id)?.wireModelId ?? id,
  })),
  findBySlug: vi.fn(async () => null),
};

const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const policyRepository = { findForExactTenant: vi.fn(async () => null), findSystemDefault: vi.fn(async () => null) };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

/** The whole chain: harness policy → text spec → agent → the cascade. */
function chain(rows: Row[]) {
  const assignments = assignmentStore(rows);
  const agents = new AgentResolverService(
    agentRepository as never,
    fallbackRepository as never,
    aiModelRepository as never,
    assignments as never,
  );
  const textAgents = new TextAgentResolverService(agents, assignments as never);
  const policy = new HarnessPolicyService(
    policyRepository as never,
    { create: vi.fn() } as never,
    { baseClient: { $transaction: vi.fn() } } as never,
    cls as never,
    undefined,
    { resolveDefault: vi.fn() } as never,
    undefined,
    undefined,
    textAgents,
  );
  return { policy, textAgents, assignments };
}

const UNQUALIFIED_ONLY: Row[] = [{ agentSlug: 'platform-summarization', selectorKey: '' }];
const SPLIT: Row[] = [
  { agentSlug: 'platform-summarization', selectorKey: '' },
  { agentSlug: 'platform-summarization-live', selectorKey: 'phase:live' },
];

beforeEach(() => vi.clearAllMocks());

describe('textPhaseSelectorTags — the reserved tag the routing task becomes', () => {
  it('is one `phase:<task>` tag per routing task, in the tag grammar TASK-884 enforces', () => {
    expect(TEXT_PHASE_TAG_KEY).toBe('phase');
    expect(textPhaseSelectorTags('live')).toEqual(['phase:live']);
    expect(textPhaseSelectorTags('finalize')).toEqual(['phase:finalize']);
    expect(textPhaseSelectorTags('test')).toEqual(['phase:test']);
  });
});

describe('resolveTextSelection — the task SELECTS again', () => {
  it('reaches the cascade as the phase tag rather than dying in an error string', async () => {
    const { policy, assignments } = chain(SPLIT);
    await policy.resolveTextSelection(TENANT, 'live');
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, null, ['phase:live']);
  });

  it('a tenant that authored a `phase:live` assignment gets the LIVE agent on live and the unqualified one on finalize', async () => {
    const { policy } = chain(SPLIT);
    await expect(policy.resolveTextSelection(TENANT, 'live')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat-live',
      generation: GENERATION,
    });
    await expect(policy.resolveTextSelection(TENANT, 'finalize')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
      generation: GENERATION,
    });
  });

  it('the department stays the tier dimension — the phase rides beside it, never instead of it', async () => {
    const { policy, assignments } = chain(SPLIT);
    await policy.resolveTextSelection(TENANT, 'live', 'dept-1');
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, 'dept-1', ['phase:live']);
  });

  it('the default task is finalize, so a no-arg caller resolves the unqualified row exactly as before', async () => {
    const { policy, assignments } = chain(SPLIT);
    await expect(policy.resolveTextSelection()).resolves.toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', generation: GENERATION });
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, null, ['phase:finalize']);
  });
});

/**
 * THE guarantee. `resolveTextSelection` is `failMode: closed`, so "a tenant that authored
 * nothing still resolves" is not a nicety — a regression is a 400 on the live flush and on the
 * finalize synthesis of every tenant provisioned before this change (their cloned reference set
 * carries the ONE unqualified row and nothing else, until a `reference-set/sync`).
 */
describe('backwards compatibility — a tenant with only the unqualified assignment is untouched', () => {
  it('live, finalize and test all resolve the SAME agent it resolves today, and none of them throws', async () => {
    const { policy } = chain(UNQUALIFIED_ONLY);
    const today = { provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', generation: GENERATION };
    await expect(policy.resolveTextSelection(TENANT, 'live')).resolves.toEqual(today);
    await expect(policy.resolveTextSelection(TENANT, 'finalize')).resolves.toEqual(today);
    await expect(policy.resolveTextSelection(TENANT, 'test')).resolves.toEqual(today);
  });

  it('an unqualified row is matched by EVERY phase — the subset rule makes it the fallback, not a competitor', async () => {
    const { assignments } = chain(UNQUALIFIED_ONLY);
    for (const phase of ['live', 'finalize', 'test'] as const) {
      await expect(assignments.resolve(TENANT, AgentTask.TEXT_GENERATION, null, textPhaseSelectorTags(phase))).resolves.toMatchObject({
        agentSlug: 'platform-summarization',
        selector: [],
      });
    }
  });

  it('the fallback selection follows the SAME phase, so a chain can never belong to the other tier`s agent', async () => {
    const { policy, assignments } = chain(SPLIT);
    await policy.resolveTextFallbackSelection(TENANT, 'live');
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, null, ['phase:live']);
  });
});
