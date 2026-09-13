/**
 * TASK-891 C2 (owner decision OD-4) — the resolved agent's GENERATION block reaches the caller.
 *
 * ## The defect this pins
 *
 * TASK-891 made the routing task a real selector: `resolveTextSelection(tenant, 'live')` resolves
 * a distinct live-tier agent through the `phase:live` assignment tag, and the seed gives that
 * agent `parameters.generation.reasoning = { enabled: false }`. Separately, TASK-891 C2 built the
 * wire: `TextRequestEnrichmentService.applyTextRuntimeProfile(target, generation)` turns that
 * block into the `GenerateRequest.reasoning` posture, which each adapter renders into its
 * own engine's parameter (TASK-970; it was `extra.reasoning_effort` under TASK-891, which
 * only the OpenAI-compatible family ever read).
 *
 * The two halves did not meet. `resolveTextSelection` LOADED the agent's parameters during
 * resolution and returned `{ provider, model }` — the block was resolved and then discarded, so
 * on the assigned-agent path nothing was ever passed as `generation`. The live agent was selected
 * and its reasoning posture had no effect. Measured on `gemma-4-e2b-it-qat`: unset costs 5168 ms
 * / 184 reasoning tokens where `minimal` costs 1237 ms / 30, against a 20 s flush budget.
 *
 * ## The shape, and why it is `generation` rather than `reasoning`
 *
 * `generation` is the authored block VERBATIM — the same value `callTextCandidate` builds for a
 * `core.agent` node and hands to `applyTextRuntimeProfile`. One shape across both live paths
 * means no translation layer to drift, and a future ride-along on `parameters.generation.*`
 * needs no further change here. It is OPTIONAL and present only when the agent authored one, so
 * `resolveTextSelection` — `failMode: closed`, with callers outside this ticket's paths — keeps
 * its exact previous shape for an agent that authored nothing.
 *
 * ## Why the REAL cascade rather than a stub
 *
 * Same reason as `harness-policy.phase-selector.task891.test.ts`: the claim is that the block
 * survives the whole resolution — the assignment cascade, the agent row, `toTextCandidate` —
 * and a stubbed resolver would only return what it was told.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { agentTagsSatisfy, canonicalAgentTags } from '@arcaai/workflow-contract';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { TextAgentResolverService } from '../../agent/text-agent-resolver.service';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

interface AgentFixture {
  wireModelId: string;
  parameters: Record<string, unknown>;
}

/** The live tier turns reasoning OFF; the finalize tier says nothing and keeps the engine default. */
const AGENTS: Record<string, AgentFixture> = {
  'platform-summarization': {
    wireModelId: 'gemma-4-e2b-it-qat',
    parameters: { generation: { temperature: 0.2, maxTokens: 2048 }, responseFormat: 'text' },
  },
  'platform-summarization-live': {
    wireModelId: 'gemma-4-e2b-it-qat-live',
    parameters: { generation: { temperature: 0.1, maxTokens: 900, reasoning: { enabled: false } }, responseFormat: 'text' },
  },
  /** A tenant agent that authored NO generation block at all — the "no opinion" shape. */
  'bare-summarization': { wireModelId: 'bare-model', parameters: { responseFormat: 'text' } },
  /** Named by `parameters.fallback.agentSlug` below; reasons HARD, which is what the primary declined. */
  'reasoning-fallback': {
    wireModelId: 'reasoner-27b',
    parameters: { generation: { reasoning: { enabled: true, effort: 'high' } }, responseFormat: 'text' },
  },
};

interface Row {
  agentSlug: string;
  selectorKey: string;
}

/** The real tier walk: subset match, most specific first, unqualified last (as TASK-884 defines it). */
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

const agentRepository = {
  findPublishedActiveBySlug: vi.fn(async (tenantId: string, slug: string) => {
    const fixture = AGENTS[slug];
    if (!fixture) return null;
    return {
      id: `agent-${slug}`,
      tenantId,
      slug,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: {
        task: 'TEXT_GENERATION',
        service: 'llm',
        model: { id: `m-${slug}`, slug: `m-${slug}`, provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
        fallbacks: [],
        instruction: null,
        resolvedPrompt: null,
        parameters: fixture.parameters,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tools: [],
        protocols: ['http'],
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
    wireModelId: AGENTS[id.replace(/^m-/, '')]?.wireModelId ?? id,
  })),
  findBySlug: vi.fn(async () => null),
};

const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const policyRepository = { findForExactTenant: vi.fn(async () => null), findSystemDefault: vi.fn(async () => null) };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

/** A fresh chain per test — `TextAgentResolverService` caches specs for 15 s, keyed by tenant+selector. */
function chain(rows: Row[]) {
  const assignments = assignmentStore(rows);
  const agents = new AgentResolverService(agentRepository as never, fallbackRepository as never, aiModelRepository as never, assignments as never);
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
  return { policy, assignments };
}

const SPLIT: Row[] = [
  { agentSlug: 'platform-summarization', selectorKey: '' },
  { agentSlug: 'platform-summarization-live', selectorKey: 'phase:live' },
];

beforeEach(() => vi.clearAllMocks());

describe('resolveTextSelection — the resolved agent`s generation block travels with the selection', () => {
  it('carries the LIVE agent`s reasoning posture, not merely its provider and model', async () => {
    const { policy } = chain(SPLIT);
    await expect(policy.resolveTextSelection(TENANT, 'live')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat-live',
      generation: { temperature: 0.1, maxTokens: 900, reasoning: { enabled: false } },
    });
  });

  it('carries the FINALIZE agent`s own block — the two tiers state different postures', async () => {
    const { policy } = chain(SPLIT);
    await expect(policy.resolveTextSelection(TENANT, 'finalize')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
      generation: { temperature: 0.2, maxTokens: 2048 },
    });
  });

  /**
   * The additive half of the contract. `resolveTextSelection` is `failMode: closed` and has
   * callers this ticket does not own (`dna-writing-style.processor.ts`, the finalize
   * processors, the TEXT proxy), so an agent with nothing to say must produce the shape they
   * already destructure — no `generation: undefined` key riding along to be spread onto a wire.
   */
  it('an agent that authored no generation block returns {provider, model} and nothing else', async () => {
    const { policy } = chain([{ agentSlug: 'bare-summarization', selectorKey: '' }]);
    const result = (await policy.resolveTextSelection(TENANT, 'finalize')) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['model', 'provider']);
  });
});

describe('resolveTextFallbackSelection — the fallback carries ITS OWN posture', () => {
  /**
   * A fallback that silently reasons when the primary declined is the same defect one layer
   * down: the switch is meant to survive a provider outage, not to change how hard the engine
   * thinks about a note the clinician is waiting for.
   */
  it('returns the fallback candidate`s generation block, not the primary`s', async () => {
    agentRepository.findPublishedActiveBySlug.mockImplementationOnce(async (tenantId: string, slug: string) => ({
      id: `agent-${slug}`,
      tenantId,
      slug,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: {
        task: 'TEXT_GENERATION',
        service: 'llm',
        model: { id: 'm-platform-summarization-live', slug: 'm-platform-summarization-live', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
        fallbacks: [],
        instruction: null,
        resolvedPrompt: null,
        parameters: {
          generation: { reasoning: { enabled: false } },
          responseFormat: 'text',
          fallback: { agentSlug: 'reasoning-fallback', autoSwitch: true },
        },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tools: [],
        protocols: ['http'],
      },
    }));

    const { policy } = chain(SPLIT);
    await expect(policy.resolveTextFallbackSelection(TENANT, 'live')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'reasoner-27b',
      generation: { reasoning: { enabled: true, effort: 'high' } },
    });
  });
});
