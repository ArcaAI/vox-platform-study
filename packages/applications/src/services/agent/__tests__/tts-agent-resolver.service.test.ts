/**
 * TASK-879 — TtsAgentResolverService: the ONE resolution from "speak this for tenant T" to a
 * `ResolvedTtsSpec`.
 *
 * What this locks: the assignment cascade and the explicit-slug path, the ordered fallback chain
 * (explicit agent → own model chain → the SYSTEM platform default), the connection block resolved
 * per engine with funding DERIVED from the tier that supplied the row, and the cloud-credential
 * posture — a veto on the PRIMARY propagates, a veto on a FALLBACK only drops that candidate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { ProviderVetoedException } from '../../ai-provider-connection/provider-vetoed.exception';
import { TtsAgentResolverService } from '../tts-agent-resolver.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel => ({
  role: 'primary',
  slug: 'kokoro',
  sourceUri: 'hexgrad/Kokoro-82M',
  sourceRevision: 'main',
  localPath: null,
  checksum: null,
  format: 'PYTORCH',
  computeType: 'float32',
  provider: 'built-in',
  tenantId: SYSTEM_TENANT_ID,
  ...over,
});

const agent = (over: Partial<ResolvedAgent> & { parameters?: Record<string, unknown> } = {}): ResolvedAgent => {
  const { parameters, ...rest } = over;
  const models = rest.models ?? [model()];
  const primary = models[0] ?? model();
  return {
    agentId: 'agent-tts-1',
    agentVersionId: 'agent-tts-1',
    slug: 'tenant-tts',
    versionNumber: 2,
    task: 'TEXT_TO_SPEECH',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_TO_SPEECH',
      service: 'tts',
      model: { id: 'm1', slug: primary.slug, provider: primary.provider, taskType: 'TEXT_TO_SPEECH' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: parameters ?? { voice: 'af_heart', language: 'en', speed: 1, format: 'wav', sampleRate: 24000 },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
      protocols: ['http'],
    },
    models,
    ...rest,
  };
};

/**
 * The tenant's own clone of the platform TTS agent (TASK-890 §3.4). A TENANT row: after OD-M the
 * SYSTEM tenant is the reference set a tenant is provisioned FROM, and no runtime resolver reads
 * it, so `platform-tts` reaches this tenant only as its own provisioned copy.
 */
const platformClone = (): ResolvedAgent =>
  agent({
    agentId: 'platform-tts',
    agentVersionId: 'platform-tts',
    slug: 'platform-tts',
    versionNumber: 1,
    tenantId: TENANT,
    source: 'tenant',
  });

const META: Record<string, unknown> = {
  kokoro: { ttsProvider: 'kokoro', voices: [{ id: 'af_heart', locale: 'en-US' }] },
  'azure-neural-voices': { voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
  'sarvam-bulbul': { voices: [{ id: 'ishita', locale: 'ml-IN' }] },
};

function harness(over: { agents?: unknown; connections?: unknown; credentials?: unknown; assignment?: string | null } = {}) {
  const agents = { resolve: vi.fn() } as { resolve: ReturnType<typeof vi.fn> };
  const assignments = {
    resolve: vi.fn().mockResolvedValue({ agentSlug: over.assignment === undefined ? 'platform-tts' : over.assignment, source: 'tenant' }),
  };
  const aiModelRepository = {
    findBySlug: vi.fn(async (_tenantId: string, slug: string) => (META[slug] ? { metaData: META[slug] } : null)),
  };
  const connections = {
    resolveConnection: vi.fn(async (_service: string, provider: string) =>
      provider === 'kokoro' ? { baseUrl: null, region: null, timeoutS: null, source: 'system' } : null,
    ),
  };
  const credentials = { resolve: vi.fn(async () => null) };
  Object.assign(connections, over.connections ?? {});
  Object.assign(credentials, over.credentials ?? {});
  const service = new TtsAgentResolverService(
    agents as never,
    assignments as never,
    aiModelRepository as never,
    connections as never,
    credentials as never,
  );
  return { service, agents, assignments, aiModelRepository, connections, credentials };
}

describe('TtsAgentResolverService — selection', () => {
  it('resolves through the AgentAssignment cascade when no slug is named', async () => {
    const h = harness();
    h.agents.resolve.mockResolvedValueOnce(platformClone());
    const { spec } = await h.service.resolve({ tenantId: TENANT, departmentId: 'dept-1' });

    expect(h.agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.TEXT_TO_SPEECH,
      agentSlug: null,
      departmentId: 'dept-1',
      primaryBinding: 'mark',
    });
    expect(spec.agent.slug).toBe('platform-tts');
    expect(spec.primary.model.provider).toBe('kokoro');
    expect(spec.primary.voice?.id).toBe('af_heart');
    expect(spec.primary.parameters.sampleRate).toBe(24000);
  });

  it('passes an explicit agentSlug through so the resolver`s 404-over-403 posture decides', async () => {
    const h = harness();
    h.agents.resolve.mockRejectedValueOnce(new NotFoundException('Agent not found'));
    await expect(h.service.resolve({ tenantId: TENANT, agentSlug: 'someone-elses-voice' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.TEXT_TO_SPEECH,
      agentSlug: 'someone-elses-voice',
      departmentId: null,
      primaryBinding: 'mark',
    });
  });

  it('refuses an agent of another task', async () => {
    const h = harness();
    await expect(h.service.resolveFromAgent(agent({ task: 'TEXT_GENERATION' }), TENANT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails CLOSED when the agent binds no primary model', async () => {
    const h = harness();
    await expect(h.service.resolveFromAgent(agent({ models: [] }), TENANT)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TtsAgentResolverService — the connection block', () => {
  it('carries the enabled row`s endpoint facts with funding derived from the tier that supplied it', async () => {
    const h = harness({
      connections: {
        resolveConnection: vi.fn(async (_s: string, provider: string) =>
          provider === 'sarvam' ? { baseUrl: 'https://vpc.sarvam.internal', region: null, timeoutS: 45, source: 'tenant' } : null,
        ),
      },
    });
    const a = agent({ models: [model({ slug: 'sarvam-bulbul', provider: 'sarvam', sourceUri: 'bulbul:v3', format: 'CLOUD_API' })] });
    h.agents.resolve.mockResolvedValue(platformClone());
    const { spec } = await h.service.resolveFromAgent(a, TENANT);

    expect(spec.primary.connection).toEqual({
      provider: 'sarvam',
      baseUrl: 'https://vpc.sarvam.internal',
      region: null,
      timeoutS: 45,
      funding: 'tenant',
    });
    expect(spec.primary.fundingTier).toBe('tenant');
  });

  it('emits `connection: null` for a self-hosted engine the platform has not enabled', async () => {
    const h = harness({ connections: { resolveConnection: vi.fn(async () => null) }, assignment: null });
    const a = agent({ tenantId: SYSTEM_TENANT_ID, models: [model({ slug: 'kokoro' })] });
    const { spec } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.primary.connection).toBeNull();
    // …and the funding falls back to whose AGENT ROW serves it — SYSTEM ⇒ platform. (The row is
    // SYSTEM-owned here to exercise that derivation; after TASK-890 L13 a tenant resolves its own
    // clone, which is tenant-funded — the rule being tested is the derivation, not the cascade.)
    expect(spec.primary.fundingTier).toBe('platform');
  });
});

/** A tenant agent whose primary is a CLOUD engine, so the kokoro platform default is a genuinely
 *  different endpoint rather than a retry the chain de-dupes away. */
const azurePrimary = (over: Partial<ResolvedAgent> & { parameters?: Record<string, unknown> } = {}) =>
  agent({
    models: [model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices', format: 'AZURE_SPEECH' })],
    ...over,
  });

describe('TtsAgentResolverService — the fallback chain', () => {
  it('walks the agent`s own model chain and terminates on the SYSTEM platform default', async () => {
    const h = harness();
    const a = azurePrimary({
      models: [
        model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' }),
        model({ role: 'fallback', slug: 'sarvam-bulbul', provider: 'sarvam', sourceUri: 'bulbul:v3', priority: 0 }),
      ],
    });
    h.agents.resolve.mockResolvedValue(platformClone());
    h.credentials.resolve.mockImplementation(async (_s: string, provider: string) => ({
      override: { api_key: `k-${provider}`, funding: 'tenant' },
      fundingTier: 'tenant',
      connectionId: 'c1',
    }));

    const { spec, providerOverrides } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.fallback.autoSwitch).toBe(true);
    // TASK-890 OD-M — the chain is the agent's OWN governance and stops there; the terminal
    // SYSTEM-assigned candidate this used to append is gone.
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['fallback-model']);
    expect(spec.fallback.chain[0]?.model.provider).toBe('sarvam');
    expect(providerOverrides).toEqual({ azure: { api_key: 'k-azure', funding: 'tenant' }, sarvam: { api_key: 'k-sarvam', funding: 'tenant' } });
  });

  it('prefers an explicit fallback AGENT over the model chain', async () => {
    const h = harness();
    const other = agent({
      agentId: 'a2',
      agentVersionId: 'a2',
      slug: 'backup-voice',
      models: [model({ slug: 'sarvam-bulbul', provider: 'sarvam', sourceUri: 'bulbul:v3' })],
    });
    const a = azurePrimary({
      parameters: { voice: 'en-IN-NeerjaNeural', fallback: { agentSlug: 'backup-voice', autoSwitch: true } },
      models: [
        model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' }),
        model({ role: 'fallback', slug: 'kokoro', provider: 'built-in', priority: 0 }),
      ],
    });
    h.agents.resolve.mockImplementation(async ({ agentSlug }: { agentSlug: string | null }) =>
      agentSlug === 'backup-voice' ? other : platformClone(),
    );
    h.credentials.resolve.mockResolvedValue({ override: { api_key: 'k', funding: 'platform' }, fundingTier: 'platform', connectionId: 'c1' });

    // The agent's OWN model chain (kokoro) is not consulted at all when it names a fallback agent.
    const { spec } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.fallback.chain.map((c) => c.model.slug)).toEqual(['sarvam-bulbul']);
    expect(spec.fallback.chain.map((c) => c.kind)).toEqual(['fallback-agent']);
  });

  it('degrades past a fallback agent that will not resolve rather than failing the synthesis', async () => {
    const h = harness();
    const a = azurePrimary({ parameters: { voice: 'en-IN-NeerjaNeural', fallback: { agentSlug: 'deleted-voice' } } });
    h.agents.resolve.mockImplementation(async ({ agentSlug }: { agentSlug: string | null }) => {
      if (agentSlug === 'deleted-voice') throw new NotFoundException('Agent not found');
      return platformClone();
    });
    h.credentials.resolve.mockResolvedValue({ override: { api_key: 'k', funding: 'platform' }, fundingTier: 'platform', connectionId: 'c1' });
    const { spec } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.fallback.chain).toEqual([]);
  });

  it('never consults the SYSTEM assignment tier for a terminal candidate (TASK-890 OD-M)', async () => {
    const h = harness();
    const { spec } = await h.service.resolveFromAgent(platformClone(), TENANT);
    expect(spec.fallback.chain).toEqual([]);
    expect(h.assignments.resolve).not.toHaveBeenCalled();
  });
});

describe('TtsAgentResolverService — cloud credentials', () => {
  const cloudAgent = () =>
    agent({ models: [model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices', format: 'AZURE_SPEECH' })] });

  it('propagates a veto on the PRIMARY — fail closed, never another tier', async () => {
    const h = harness({ credentials: { resolve: vi.fn().mockRejectedValue(new ProviderVetoedException('tts', 'azure', TENANT)) } });
    await expect(h.service.resolveFromAgent(cloudAgent(), TENANT)).rejects.toBeInstanceOf(ProviderVetoedException);
  });

  it('drops only the candidate when a FALLBACK`s credential is refused', async () => {
    const h = harness();
    const a = agent({
      models: [
        model({ slug: 'sarvam-bulbul', provider: 'sarvam', sourceUri: 'bulbul:v3' }),
        model({ role: 'fallback', slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://x', priority: 0 }),
      ],
    });
    h.agents.resolve.mockResolvedValue(platformClone());
    h.credentials.resolve.mockImplementation(async (_s: string, provider: string) => {
      if (provider === 'azure') throw new QuotaExceededException('not entitled', { capability: 'x', limit: 0, used: 0, requested: 1 });
      return { override: { api_key: 'k', funding: 'tenant' }, fundingTier: 'tenant', connectionId: 'c1' };
    });

    const { spec, providerOverrides } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.fallback.chain).toEqual([]);
    expect(providerOverrides).toEqual({ sarvam: { api_key: 'k', funding: 'tenant' } });
  });

  it('carries no credential for an engine the de-duped chain dropped', async () => {
    const h = harness();
    // The named fallback agent binds the SAME engine + model id behind the SAME tier as the
    // primary, so the chain drops it — and the key must not ride the wire for an engine nothing
    // routes to.
    const a = agent({
      parameters: { voice: 'af_heart', fallback: { agentSlug: 'twin-voice' } },
      models: [model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' })],
    });
    h.agents.resolve.mockResolvedValue(
      agent({
        agentId: 'p',
        agentVersionId: 'p',
        slug: 'twin-voice',
        models: [model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' })],
      }),
    );
    h.credentials.resolve.mockResolvedValue({ override: { api_key: 'k', funding: 'platform' }, fundingTier: 'platform', connectionId: 'c1' });
    const { spec, providerOverrides } = await h.service.resolveFromAgent(a, TENANT);
    expect(spec.fallback.chain).toEqual([]);
    expect(providerOverrides).toEqual({ azure: { api_key: 'k', funding: 'platform' } });
  });
});
