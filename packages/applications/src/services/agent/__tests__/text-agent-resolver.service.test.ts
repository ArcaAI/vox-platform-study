/**
 * TASK-876 — TextAgentResolverService: the TEXT_GENERATION counterpart of `AsrAgentResolverService`.
 *
 * One resolution from "generate text for tenant T" to a `ResolvedTextGenerationSpec`: the
 * primary (the assigned or explicit agent's model, provider, prompt, parameters, funding) and an
 * ORDERED fallback chain — the explicit `parameters.fallback.agentSlug` if set, else the agent's
 * own `AgentModelFallback` chain, and ALWAYS the SYSTEM-assigned agent as the platform default
 * terminating it (owner decision #4: fallback is a platform HA capability, on by default).
 * `autoSwitch` is the tenant's per-agent toggle and is carried, never decided here. Funding is
 * DERIVED per candidate from the row that serves it (rule 09 §Tenant-first resolution & BYO).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { ProviderVetoedException } from '../../ai-provider-connection/provider-vetoed.exception';
import { TextAgentResolverService } from '../text-agent-resolver.service';

// A plain customer tenant. NOT `50000000-…` ("Global"): that is a RESERVED id — the
// platform-admin playground tenant — and a cascade test whose caller is a reserved tenant
// cannot show that the cascade is `request tenant → SYSTEM` and nothing else.
const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel => ({
  role: 'primary',
  slug: 'lms-gemma-4-e2b-it-qat',
  sourceUri: 'gemma-4-e2b-it-qat',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'GGUF',
  computeType: null,
  provider: 'lm-studio',
  tenantId: SYSTEM_TENANT_ID,
  ...over,
});

const agent = (over: Partial<ResolvedAgent> & { parameters?: Record<string, unknown> } = {}): ResolvedAgent => {
  const { parameters, ...rest } = over;
  const primary = rest.models?.[0] ?? model();
  return {
    agentId: 'agent-1',
    agentVersionId: 'agent-1',
    slug: 'clinic-summarizer',
    versionNumber: 3,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: primary.slug, provider: primary.provider, taskType: 'TEXT_GENERATION' },
      fallbacks: [],
      instruction: { promptTemplateId: 'tmpl-1', promptVersionNumber: 2 },
      resolvedPrompt: { source: 'template', promptTemplateId: 'tmpl-1', promptVersionNumber: 2, content: 'You are a SOAP writer.' },
      parameters: parameters ?? { generation: { temperature: 0.2, maxTokens: 2048 }, responseFormat: 'text' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
      protocols: ['http'],
    },
    models: [primary],
    ...rest,
  };
};

const platformAgent = (): ResolvedAgent =>
  agent({
    agentId: 'platform-1',
    agentVersionId: 'platform-1',
    slug: 'platform-summarization',
    tenantId: SYSTEM_TENANT_ID,
    source: 'platform-default',
  });

const agents = { resolve: vi.fn() };
const assignments = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };

const make = (withCredentials = true) =>
  new TextAgentResolverService(agents as never, assignments as never, withCredentials ? (credentials as never) : undefined);

/** `agents.resolve` answering by slug: the tenant's own agent by default, the platform one for its slug. */
function bySlug(map: Record<string, ResolvedAgent | Error>, unassigned?: ResolvedAgent) {
  agents.resolve.mockImplementation(async (input: { agentSlug?: string | null }) => {
    if (!input.agentSlug) {
      if (!unassigned) throw new NotFoundException('No published TEXT_GENERATION agent is assigned for this tenant.');
      return unassigned;
    }
    const answer = map[input.agentSlug];
    if (answer === undefined) throw new NotFoundException('Agent not found');
    if (answer instanceof Error) throw answer;
    return { ...answer, source: 'explicit' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
  assignments.resolve.mockResolvedValue({ agentSlug: 'platform-summarization', source: 'platform-default' });
});

describe('TextAgentResolverService.resolve — the primary', () => {
  it('no slug → the assignment cascade through the ONE agent resolver, task pinned to TEXT_GENERATION', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent());
    const spec = await make().resolve({ tenantId: TENANT, departmentId: 'dept-1' });
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: null, departmentId: 'dept-1' });
    expect(spec.schemaVersion).toBe(1);
    expect(spec.primary).toMatchObject({
      kind: 'primary',
      agent: { slug: 'clinic-summarizer', versionId: 'agent-1', versionNumber: 3, tenantId: TENANT, source: 'tenant' },
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
      resolvedPrompt: { source: 'template', content: 'You are a SOAP writer.' },
      parameters: { generation: { temperature: 0.2, maxTokens: 2048 } },
    });
  });

  it('the wire provider is what apps/text registers (`azure` → `azure-openai`) and the model is the provider-native sourceUri', async () => {
    bySlug(
      { 'platform-summarization': platformAgent() },
      agent({ models: [model({ slug: 'azure-gpt', provider: 'azure', sourceUri: 'gpt-5.4-mini' })] }),
    );
    const spec = await make(false).resolve({ tenantId: TENANT });
    expect(spec.primary.provider).toBe('azure-openai');
    expect(spec.primary.model).toBe('gpt-5.4-mini');
  });

  it('explicit slug + matching version pin passes; a drifted pin FAILS CLOSED (409), exactly as the Temporal lane refuses it', async () => {
    bySlug({ 'clinic-summarizer': agent(), 'platform-summarization': platformAgent() });
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer', versionNumber: 3 })).resolves.toMatchObject({
      primary: { agent: { versionNumber: 3 } },
    });
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer', versionNumber: 2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('foreign / unknown slug → the agent resolver’s one 404 propagates (404-over-403); nothing assigned → 404', async () => {
    bySlug({});
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'not-mine' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make().resolve({ tenantId: TENANT })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a primary whose model has no provider-native id is unrunnable → 409, never a guessed model', async () => {
    bySlug({}, agent({ models: [model({ sourceUri: '' })] }));
    await expect(make().resolve({ tenantId: TENANT })).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolveFromAgent refuses a non-TEXT_GENERATION agent', async () => {
    await expect(make().resolveFromAgent(agent({ task: 'SPEECH_TO_TEXT' }), TENANT)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TextAgentResolverService.resolve — the ordered fallback chain', () => {
  it('a tenant agent with no fallback of its own still falls back to the SYSTEM-assigned agent (platform HA, on by default)', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent());
    const spec = await make().resolve({ tenantId: TENANT });
    expect(assignments.resolve).toHaveBeenCalledWith(SYSTEM_TENANT_ID, AgentTask.TEXT_GENERATION, null);
    expect(spec.fallback).toMatchObject({ autoSwitch: true, switchAfterConsecutiveFailures: 2 });
    expect(spec.fallback.chain.map((c) => [c.kind, c.agent.slug])).toEqual([['platform-default', 'platform-summarization']]);
    // The platform agent resolves VISIBLE TO THE TENANT (it is a SYSTEM row), never as a cross-tenant read.
    expect(agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.TEXT_GENERATION,
      agentSlug: 'platform-summarization',
      departmentId: null,
    });
  });

  it('when the primary IS the platform default the chain is empty (nothing to fall back to)', async () => {
    bySlug({}, platformAgent());
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.primary.kind).toBe('primary');
    expect(spec.primary.agent.source).toBe('platform-default');
    expect(spec.fallback.chain).toEqual([]);
    expect(assignments.resolve).not.toHaveBeenCalled();
  });

  it('an explicit parameters.fallback.agentSlug is resolved first; the agent’s own model chain is then NOT used', async () => {
    const backup = agent({
      agentId: 'backup-1',
      agentVersionId: 'backup-1',
      slug: 'clinic-backup',
      models: [model({ slug: 'backup-model', sourceUri: 'backup' })],
    });
    const primary = agent({
      parameters: { fallback: { agentSlug: 'clinic-backup', autoSwitch: true, switchAfterConsecutiveFailures: 3 } },
      models: [model(), model({ role: 'fallback', priority: 0, slug: 'own-fallback', sourceUri: 'own-fallback' })],
    });
    bySlug({ 'clinic-backup': backup, 'platform-summarization': platformAgent() }, primary);
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback).toMatchObject({ autoSwitch: true, switchAfterConsecutiveFailures: 3 });
    expect(spec.fallback.chain.map((c) => [c.kind, c.agent.slug, c.modelSlug])).toEqual([
      ['fallback-agent', 'clinic-backup', 'backup-model'],
      ['platform-default', 'platform-summarization', 'lms-gemma-4-e2b-it-qat'],
    ]);
  });

  it('without an explicit agent, the agent’s own AgentModelFallback chain serves in priority order, then the platform default', async () => {
    const primary = agent({
      models: [
        model(),
        model({ role: 'fallback', priority: 1, slug: 'second', sourceUri: 'second-uri' }),
        model({ role: 'fallback', priority: 0, slug: 'first', sourceUri: 'first-uri' }),
      ],
    });
    bySlug({ 'platform-summarization': platformAgent() }, primary);
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain.map((c) => [c.kind, c.agent.slug, c.modelSlug, c.model])).toEqual([
      ['fallback-model', 'clinic-summarizer', 'first', 'first-uri'],
      ['fallback-model', 'clinic-summarizer', 'second', 'second-uri'],
      ['platform-default', 'platform-summarization', 'lms-gemma-4-e2b-it-qat', 'gemma-4-e2b-it-qat'],
    ]);
  });

  // Owner decision: fallback is a PLATFORM HA capability. A tenant may disable it only for a
  // primary it FUNDS; on a platform-funded primary the toggle is ignored. The resolver is the
  // single chokepoint that decides this, so no consumer has to re-derive funding to obey it.
  it('a BYO (tenant-funded) primary honours autoSwitch:false — the chain is reported, the runtime must not switch', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent({ parameters: { fallback: { autoSwitch: false } } }));
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.primary.fundingTier).toBe('tenant');
    expect(spec.fallback.autoSwitch).toBe(false);
    expect(spec.fallback.chain).toHaveLength(1);
  });

  it('a PLATFORM-funded primary IGNORES autoSwitch:false — the chain is always walked (platform HA is platform-controlled)', async () => {
    // A SYSTEM-owned agent the tenant pinned explicitly: the row that serves is SYSTEM's, so
    // the generation is platform spend and the tenant does not get to switch HA off for it.
    const systemOwned = agent({
      agentId: 'sys-1',
      agentVersionId: 'sys-1',
      slug: 'platform-clinical',
      tenantId: SYSTEM_TENANT_ID,
      parameters: { fallback: { autoSwitch: false } },
    });
    bySlug({ 'platform-clinical': systemOwned, 'platform-summarization': platformAgent() });
    const spec = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-clinical' });
    expect(spec.primary.fundingTier).toBe('platform');
    expect(spec.fallback.autoSwitch).toBe(true);
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['platform-default']);
  });

  it('a tenant agent served by the PLATFORM cloud credential is platform-funded — autoSwitch:false is ignored there too', async () => {
    bySlug(
      { 'platform-summarization': platformAgent() },
      agent({
        parameters: { fallback: { autoSwitch: false } },
        models: [model({ slug: 'azure-gpt', provider: 'azure', sourceUri: 'gpt-5.4-mini' })],
      }),
    );
    credentials.resolve.mockResolvedValue({ override: { api_key: 'k', funding: 'platform' }, fundingTier: 'platform', connectionId: 'c1' });
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.primary.fundingTier).toBe('platform');
    expect(spec.fallback.autoSwitch).toBe(true);
  });

  it('a fallback agent that will not resolve DEGRADES to the next option — resilience config never blocks the primary', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent({ parameters: { fallback: { agentSlug: 'deleted-agent' } } }));
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['platform-default']);
  });

  it('the platform default is never listed twice (explicit fallback agent IS the platform agent)', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent({ parameters: { fallback: { agentSlug: 'platform-summarization' } } }));
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain.map((c) => [c.kind, c.agent.slug])).toEqual([['fallback-agent', 'platform-summarization']]);
  });

  it('no SYSTEM assignment at all → the chain ends without a platform default (reported, never invented)', async () => {
    assignments.resolve.mockResolvedValue({ agentSlug: null, source: 'platform-default' });
    bySlug({}, agent());
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain).toEqual([]);
  });
});

describe('TextAgentResolverService.resolve — funding is derived per candidate from the row that serves it', () => {
  it('self-hosted models: a tenant-owned agent row is tenant-funded, the SYSTEM-owned platform default is platform-funded', async () => {
    bySlug({ 'platform-summarization': platformAgent() }, agent());
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.primary.fundingTier).toBe('tenant');
    expect(spec.fallback.chain[0].fundingTier).toBe('platform');
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('a cloud provider resolves its credential through the ONE credential resolver, funding from the binding', async () => {
    bySlug(
      { 'platform-summarization': platformAgent() },
      agent({ models: [model({ slug: 'azure-gpt', provider: 'azure', sourceUri: 'gpt-5.4-mini' })] }),
    );
    credentials.resolve.mockImplementation(async (_service: string, provider: string) =>
      provider === 'azure'
        ? { override: { api_key: 'k', funding: 'platform', deployment_name: 'gpt' }, fundingTier: 'platform', connectionId: 'c1' }
        : null,
    );
    const spec = await make().resolve({ tenantId: TENANT });
    expect(credentials.resolve).toHaveBeenCalledWith('llm', 'azure', TENANT);
    expect(spec.primary.fundingTier).toBe('platform');
    expect(spec.primary.providerOverride).toMatchObject({ provider: 'azure', api_key: 'k', funding: 'platform', deployment_name: 'gpt' });
    // The self-hosted platform default keeps its own row-derived funding.
    expect(spec.fallback.chain[0]).toMatchObject({ kind: 'platform-default', fundingTier: 'platform' });
    expect(spec.fallback.chain[0].providerOverride).toBeUndefined();
  });

  it('a vetoed cloud PRIMARY propagates (fail closed); a vetoed or un-entitled cloud FALLBACK is left out of the chain', async () => {
    const cloudBackup = agent({
      agentId: 'b',
      agentVersionId: 'b',
      slug: 'cloud-backup',
      models: [model({ slug: 'az', provider: 'azure', sourceUri: 'gpt' })],
    });
    bySlug(
      { 'cloud-backup': cloudBackup, 'platform-summarization': platformAgent() },
      agent({ parameters: { fallback: { agentSlug: 'cloud-backup' } } }),
    );
    credentials.resolve.mockRejectedValueOnce(new ProviderVetoedException('llm', 'azure', TENANT));
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['platform-default']);

    credentials.resolve.mockRejectedValueOnce(new QuotaExceededException('featurePlatformDefaultCredential'));
    const spec2 = await make().resolve({ tenantId: TENANT });
    expect(spec2.fallback.chain.map((c) => c.kind)).toEqual(['platform-default']);

    bySlug({ 'platform-summarization': platformAgent() }, agent({ models: [model({ slug: 'az', provider: 'azure', sourceUri: 'gpt' })] }));
    credentials.resolve.mockRejectedValueOnce(new ProviderVetoedException('llm', 'azure', TENANT));
    await expect(make().resolve({ tenantId: TENANT })).rejects.toBeInstanceOf(ProviderVetoedException);
  });

  it('a cloud fallback with no credential at either tier is dropped (it could only 503); a cloud primary is kept and attributable', async () => {
    const cloudBackup = agent({
      agentId: 'b',
      agentVersionId: 'b',
      slug: 'cloud-backup',
      models: [model({ slug: 'az', provider: 'openai', sourceUri: 'gpt' })],
    });
    bySlug(
      { 'cloud-backup': cloudBackup, 'platform-summarization': platformAgent() },
      agent({ parameters: { fallback: { agentSlug: 'cloud-backup' } } }),
    );
    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['platform-default']);

    bySlug({ 'platform-summarization': platformAgent() }, agent({ models: [model({ slug: 'az', provider: 'openai', sourceUri: 'gpt' })] }));
    const spec2 = await make().resolve({ tenantId: TENANT });
    expect(spec2.primary).toMatchObject({ provider: 'openai', fundingTier: 'tenant' });
    expect(spec2.primary.providerOverride).toBeUndefined();
  });

  it('without TASK-862’s resolver wired, the agent resolver’s own providerOverride / fundingTier serve the primary', async () => {
    bySlug(
      { 'platform-summarization': platformAgent() },
      agent({
        models: [model({ slug: 'az', provider: 'azure', sourceUri: 'gpt' })],
        providerOverride: { provider: 'azure', api_key: 'k', funding: 'tenant' },
        fundingTier: 'tenant',
      }),
    );
    const spec = await make(false).resolve({ tenantId: TENANT });
    expect(spec.primary).toMatchObject({ fundingTier: 'tenant', providerOverride: { provider: 'azure', api_key: 'k' } });
  });
});
