/**
 * TASK-958 G2a — the review findings on the BINDING/ATTRIBUTION half of the wire.
 *
 * F6  — a sibling's map key shares a namespace with provider ids, so a tenant that
 *       names a `sarvam` connection `azure` aliases the platform's `azure` entry.
 * F11 — a PRIMARY binding that fails closed must not be widened to the tenant's
 *       DEFAULT account by a caller that folds by provider name.
 * F12 — the TTS spec's `connection.connectionId` must come from the override entry
 *       that actually served, so the spec and the credential agree structurally.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { AGENT_CONNECTION_UNAVAILABLE, AgentResolverService, providerOverrideKey } from '../agent-resolver.service';
import { TtsAgentResolverService } from '../tts-agent-resolver.service';
import { AgentDraftTestService } from '../agent-draft-test.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

// ── TTS harness ────────────────────────────────────────────────────────────────

type Row = { id: string; slug: string; provider: string; isDefault: boolean; key: string; enabled?: boolean };

const META: Record<string, unknown> = {
  'azure-neural-voices': { ttsProvider: 'azure', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
  'azure-neural-voices-research': { ttsProvider: 'azure', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
  'sarvam-bulbul': { ttsProvider: 'sarvam', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
};

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel => ({
  role: 'primary',
  slug: 'azure-neural-voices',
  sourceUri: 'azure-tts',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'API',
  computeType: null,
  provider: 'azure',
  tenantId: TENANT,
  ...over,
});

const ttsAgent = (models: ResolvedAgentModel[]): ResolvedAgent => ({
  agentId: 'agent-tts-1',
  agentVersionId: 'agent-tts-1',
  slug: 'tenant-tts',
  versionNumber: 1,
  task: 'TEXT_TO_SPEECH',
  tenantId: TENANT,
  source: 'tenant',
  compiledConfig: {
    task: 'TEXT_TO_SPEECH',
    service: 'tts',
    model: { id: 'm1', slug: models[0].slug, provider: models[0].provider, taskType: 'TEXT_TO_SPEECH' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: { voice: 'en-IN-NeerjaNeural', language: 'en' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
  },
  models,
  guardrail: { enabled: true },
});

function ttsHarness(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const agents = { resolve: vi.fn() };
  const assignments = { resolve: vi.fn() };
  const aiModelRepository = { findBySlug: vi.fn(async (_t: string, slug: string) => (META[slug] ? { metaData: META[slug] } : null)) };
  const connections = {
    list: vi.fn(async () => rows.map((r) => ({ id: r.id, slug: r.slug, provider: r.provider, isDefault: r.isDefault, enabled: r.enabled ?? true, hasKey: true }))),
    resolveConnection: vi.fn(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) => {
      if (options?.connectionId && !byId.has(options.connectionId)) return null;
      return { baseUrl: null, region: 'westus', timeoutS: null, source: options?.connectionId ? ('tenant' as const) : ('system' as const) };
    }),
  };
  const credentials = {
    resolve: vi.fn(async (_s: string, provider: string, _t: string, options?: { connectionId?: string }) => {
      const id = options?.connectionId;
      const row = id ? byId.get(id) : undefined;
      if (id && (!row || row.enabled === false)) return null;
      return {
        override: {
          api_key: row?.key ?? 'platform-key',
          funding: (id ? 'tenant' : 'platform') as 'tenant' | 'platform',
          connection_id: id ?? `system-${provider}`,
          connection_slug: row?.slug ?? provider,
        },
        fundingTier: (id ? 'tenant' : 'platform') as 'tenant' | 'platform',
        // DELIBERATELY different from `override.connection_id` so F12 can tell which of the
        // two the spec block was stamped from.
        connectionId: id ? `resolver-said-${id}` : `system-${provider}`,
      };
    }),
  };
  const service = new TtsAgentResolverService(agents as never, assignments as never, aiModelRepository as never, connections as never, credentials as never);
  return { service, credentials, connections };
}

describe('TASK-958 F6 — the override key is namespaced, so a slug can never alias a provider id', () => {
  it('a NON-default sibling named `azure` under provider `sarvam` is filed under `sarvam:azure`, leaving the platform `azure` entry alone', async () => {
    // The tenant holds one sarvam connection it chose to call "azure", plus the platform's
    // real azure. With the bare slug as the key they collide on `azure`.
    const h = ttsHarness([
      { id: 'conn-sarvam-2', slug: 'azure', provider: 'sarvam', isDefault: false, key: 'sarvam-sibling-key' },
      { id: 'conn-azure-1', slug: 'azure', provider: 'azure', isDefault: true, key: 'azure-default-key' },
    ]);
    const resolved = await h.service.resolveFromAgent(
      ttsAgent([
        model({ sourceConnectionId: 'conn-azure-1' }),
        model({ role: 'fallback', priority: 0, slug: 'sarvam-bulbul', provider: 'sarvam', sourceConnectionId: 'conn-sarvam-2' }),
      ]),
      TENANT,
    );

    expect(resolved.spec.primary.connectionKey).toBe('azure');
    expect(resolved.spec.fallback.chain[0].connectionKey).toBe('sarvam:azure');
    expect(Object.keys(resolved.providerOverrides ?? {}).sort()).toEqual(['azure', 'sarvam:azure']);
    expect(resolved.providerOverrides?.['azure'].api_key).toBe('azure-default-key');
    expect(resolved.providerOverrides?.['sarvam:azure'].api_key).toBe('sarvam-sibling-key');
  });

  it('a DEMOTED original (slug === provider but no longer the default) does not take the bare provider key', async () => {
    const h = ttsHarness([
      { id: 'conn-azure-old', slug: 'azure', provider: 'azure', isDefault: false, key: 'demoted-key' },
      { id: 'conn-azure-new', slug: 'azure-research', provider: 'azure', isDefault: true, key: 'promoted-key' },
    ]);
    const resolved = await h.service.resolveFromAgent(
      ttsAgent([
        model({ sourceConnectionId: 'conn-azure-new' }),
        model({ role: 'fallback', priority: 0, slug: 'azure-neural-voices-research', sourceConnectionId: 'conn-azure-old' }),
      ]),
      TENANT,
    );

    // The DEFAULT keeps the bare provider key whatever it is called…
    expect(resolved.spec.primary.connectionKey).toBe('azure');
    // …and the demoted row is namespaced, so the two cannot share one entry.
    expect(resolved.spec.fallback.chain[0].connectionKey).toBe('azure:azure');
    expect(resolved.providerOverrides?.['azure'].api_key).toBe('promoted-key');
    expect(resolved.providerOverrides?.['azure:azure'].api_key).toBe('demoted-key');
  });

  it('two candidates on ONE connection decrypt it once (the per-key memo), and both keep the key', async () => {
    const h = ttsHarness([{ id: 'conn-azure-1', slug: 'azure', provider: 'azure', isDefault: true, key: 'azure-default-key' }]);
    const resolved = await h.service.resolveFromAgent(
      ttsAgent([
        model({ sourceConnectionId: 'conn-azure-1' }),
        model({ role: 'fallback', priority: 0, slug: 'azure-neural-voices-research', sourceConnectionId: 'conn-azure-1' }),
      ]),
      TENANT,
    );
    expect(resolved.spec.primary.connectionKey).toBe('azure');
    expect(h.credentials.resolve).toHaveBeenCalledTimes(1);
    expect(Object.keys(resolved.providerOverrides ?? {})).toEqual(['azure']);
  });

  it('the pure rule: default/platform → the provider id, sibling → `provider:slug`', () => {
    expect(providerOverrideKey('azure', { slug: 'azure', isDefault: true })).toBe('azure');
    expect(providerOverrideKey('azure', { slug: 'azure-research', isDefault: true })).toBe('azure');
    expect(providerOverrideKey('azure', { slug: 'azure-research', isDefault: false })).toBe('azure:azure-research');
    expect(providerOverrideKey('azure', null)).toBe('azure');
    // Unknown default-ness degrades to the naming convention, never to an alias of a sibling.
    expect(providerOverrideKey('azure', { slug: 'azure-research' })).toBe('azure:azure-research');
  });
});

describe('TASK-958 F12 — the TTS connection block is stamped from the override entry that served', () => {
  it('`connection.connectionId` equals the entry`s `connection_id`, not the resolver`s own field', async () => {
    const h = ttsHarness([{ id: 'conn-azure-2', slug: 'azure-research', provider: 'azure', isDefault: false, key: 'k' }]);
    const resolved = await h.service.resolveFromAgent(ttsAgent([model({ sourceConnectionId: 'conn-azure-2' })]), TENANT);
    expect(resolved.spec.primary.connection).toMatchObject({ connectionId: 'conn-azure-2', connectionSlug: 'azure-research' });
    expect(resolved.providerOverrides?.['azure:azure-research'].connection_id).toBe('conn-azure-2');
  });
});

// ── AgentResolverService: the fail-closed primary (F11) ────────────────────────

const llmModel = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel => ({
  role: 'primary',
  slug: 'gpt-5-4-mini',
  sourceUri: 'openai://gpt-5.4-mini',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'API',
  computeType: null,
  provider: 'openai',
  tenantId: TENANT,
  ...over,
});

function agentHarness(resolveCredential: (options?: { connectionId?: string }) => unknown, boundConnectionId: string | null = 'conn-openai-2') {
  const entity = {
    id: 'agent-1',
    slug: 'clinic-writer',
    versionNumber: 3,
    task: AgentTask.TEXT_GENERATION,
    tenantId: TENANT,
    compiledConfig: {
      task: AgentTask.TEXT_GENERATION,
      service: 'llm',
      model: { id: 'm1', slug: 'gpt-5-4-mini', provider: 'openai', taskType: 'TEXT_GENERATION' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
    },
  };
  const agentRepository = { findPublishedActiveBySlug: vi.fn(async () => entity) };
  const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
  const aiModelRepository = {
    findById: vi.fn(async () => ({ ...llmModel(), id: 'm1', ...(boundConnectionId ? { sourceConnectionId: boundConnectionId } : {}), metaData: null, libraryName: null })),
    findBySlug: vi.fn(async () => null),
  };
  const assignments = { resolve: vi.fn() };
  const providerConnections = { resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: { openai: { api_key: 'DEFAULT-ACCOUNT', funding: 'tenant' } } })) };
  const credentials = { resolve: vi.fn(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) => resolveCredential(options)) };
  const service = new AgentResolverService(
    agentRepository as never,
    fallbackRepository as never,
    aiModelRepository as never,
    assignments as never,
    providerConnections as never,
    undefined,
    credentials as never,
  );
  return { service, providerConnections, credentials };
}

describe('TASK-958 F11 — a failed-closed PRIMARY binding never widens to the default account', () => {
  it('the default policy throws 409 AGENT_CONNECTION_UNAVAILABLE when the named connection is disabled or keyless', async () => {
    const h = agentHarness(() => null);
    await expect(h.service.resolve({ tenantId: TENANT, agentSlug: 'clinic-writer' })).rejects.toMatchObject({
      response: { code: AGENT_CONNECTION_UNAVAILABLE, agentSlug: 'clinic-writer', modelSlug: 'gpt-5-4-mini', connectionId: 'conn-openai-2' },
    });
    // …and the provider-name fold — the tenant's DEFAULT account — was never consulted.
    expect(h.providerConnections.resolveTenantCloudOverrides).not.toHaveBeenCalled();
  });

  it('an unknown or foreign connection id is a failed-closed binding too, not a bare 404', async () => {
    const h = agentHarness(() => {
      throw new NotFoundException("No connection row 'conn-openai-2'");
    });
    await expect(h.service.resolve({ tenantId: TENANT, agentSlug: 'clinic-writer' })).rejects.toBeInstanceOf(ConflictException);
  });

  it("`primaryBinding: 'mark'` skips the primary instead, so a chain plane can walk its fallbacks", async () => {
    const h = agentHarness(() => null);
    const resolved = await h.service.resolve({ tenantId: TENANT, agentSlug: 'clinic-writer', primaryBinding: 'mark' });
    expect(resolved.providerOverride).toBeUndefined();
    expect(h.providerConnections.resolveTenantCloudOverrides).not.toHaveBeenCalled();
  });

  it('a SYSTEM catalogue model (no bound connection) still resolves through the provider-name cascade — unchanged', async () => {
    const h = agentHarness(() => null, null);
    const resolved = await h.service.resolve({ tenantId: TENANT, agentSlug: 'clinic-writer' });
    expect(h.providerConnections.resolveTenantCloudOverrides).toHaveBeenCalledWith('llm', TENANT);
    expect(resolved.providerOverride).toMatchObject({ provider: 'openai', api_key: 'DEFAULT-ACCOUNT' });
  });
});

// ── the draft-agent test bench (F11, second half) ──────────────────────────────

describe('TASK-958 F11 — the bench spends the account the draft is BOUND to', () => {
  const cls = { get: vi.fn(() => TENANT) };
  const enrichment = {
    applyTextRuntimeProfile: vi.fn(async () => undefined),
    applyTenantProviderOverrides: vi.fn(async (target: { provider_overrides?: unknown }) => {
      // The real enrichment returns early when the caller already resolved one; a
      // test that let it overwrite would pin the very bug this fixes.
      if (target.provider_overrides) return target;
      (target as Record<string, unknown>).provider_overrides = { 'azure-openai': { api_key: 'DEFAULT-ACCOUNT', funding: 'tenant' } };
      return target;
    }),
  };
  const post = vi.fn(async () => ({ data: Readable.from([Buffer.from('event: meta\ndata: {"generation_id":"task-1"}\n\n')]) }));
  const httpService = { axiosRef: { post, get: vi.fn() } };

  const bench = (resolveCredential: () => unknown) =>
    new AgentDraftTestService(
      cls as never,
      httpService as never,
      { get: vi.fn(() => 'http://text:8862') } as never,
      undefined,
      enrichment as never,
      undefined,
      undefined,
      { resolve: vi.fn(async () => resolveCredential()) } as never,
    );

  it('pre-sets provider_overrides from the BOUND connection, so the enrichment`s default fold never runs', async () => {
    await bench(() => ({
      override: { api_key: 'SIBLING-ACCOUNT', funding: 'tenant', connection_id: 'conn-openai-2', connection_slug: 'openai-research' },
      fundingTier: 'tenant',
      connectionId: 'conn-openai-2',
    })).submit({
      tenantId: TENANT,
      prompt: 'hi',
      systemPrompt: null,
      provider: 'azure-openai',
      model: 'gpt-5.4-mini',
      guardrailEnabled: true,
      connectionId: 'conn-openai-2',
      connectionProvider: 'azure',
    });

    const body = post.mock.calls.at(-1)?.[1] as { provider_overrides?: Record<string, { api_key?: string }> };
    expect(body.provider_overrides?.['azure-openai']?.api_key).toBe('SIBLING-ACCOUNT');
  });

  it('a failed-closed binding refuses the run instead of benching on the default account', async () => {
    await expect(
      bench(() => null).submit({
        tenantId: TENANT,
        prompt: 'hi',
        systemPrompt: null,
        provider: 'azure-openai',
        model: 'gpt-5.4-mini',
        guardrailEnabled: true,
        connectionId: 'conn-openai-2',
        connectionProvider: 'azure',
      }),
    ).rejects.toMatchObject({ response: { code: AGENT_CONNECTION_UNAVAILABLE } });
  });

  it('an UNBOUND draft is unchanged — the enrichment folds the tenant`s default', async () => {
    await bench(() => null).submit({
      tenantId: TENANT,
      prompt: 'hi',
      systemPrompt: null,
      provider: 'azure-openai',
      model: 'gpt-5.4-mini',
      guardrailEnabled: true,
    });
    const body = post.mock.calls.at(-1)?.[1] as { provider_overrides?: Record<string, { api_key?: string }> };
    expect(body.provider_overrides?.['azure-openai']?.api_key).toBe('DEFAULT-ACCOUNT');
  });
});
