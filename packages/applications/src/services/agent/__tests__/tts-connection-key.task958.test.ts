/**
 * TASK-958 D-4 — the TTS wire learns WHICH account of a vendor a candidate spends.
 *
 * `apps/tts` walks the fallback chain itself, so this is where the collision was
 * real: two candidates naming the SAME engine on DIFFERENT connections both read
 * `provider_overrides[engine]` and the failover spends the key that just failed.
 * The fix is a per-candidate `connectionKey` — the engine name for the tenant's
 * DEFAULT row and for a platform row, `engine:slug` for a named sibling (G2a F6:
 * a bare slug would share a namespace with provider ids) — and a
 * `provider_overrides` map keyed by it, which leaves every default/platform
 * payload byte-identical because there `connectionKey === engine`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { TtsAgentResolverService } from '../tts-agent-resolver.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';
const AZURE_1 = 'conn-azure-primary';
const AZURE_2 = 'conn-azure-research';

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

const META: Record<string, unknown> = {
  'azure-neural-voices': { ttsProvider: 'azure', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
  'azure-neural-voices-research': { ttsProvider: 'azure', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
  kokoro: { ttsProvider: 'kokoro', voices: [{ id: 'af_heart', locale: 'en-US' }] },
};

const agent = (models: ResolvedAgentModel[]): ResolvedAgent => ({
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

function harness(byId: Record<string, { slug: string; key: string }>) {
  const agents = { resolve: vi.fn() };
  const assignments = { resolve: vi.fn() };
  const aiModelRepository = { findBySlug: vi.fn(async (_t: string, slug: string) => (META[slug] ? { metaData: META[slug] } : null)) };
  const connections = {
    resolveConnection: vi.fn(async (_s: string, provider: string, _t: string, options?: { connectionId?: string }) => {
      const row = options?.connectionId ? byId[options.connectionId] : undefined;
      if (options?.connectionId && !row) return null;
      void provider;
      return { baseUrl: null, region: 'westus', timeoutS: null, source: options?.connectionId ? ('tenant' as const) : ('system' as const) };
    }),
  };
  const credentials = {
    resolve: vi.fn(async (_s: string, provider: string, _t: string, options?: { connectionId?: string }) => {
      const id = options?.connectionId;
      const row = id ? byId[id] : undefined;
      if (id && !row) return null;
      return {
        override: {
          api_key: row?.key ?? 'platform-key',
          funding: (id ? 'tenant' : 'platform') as 'tenant' | 'platform',
          connection_id: id ?? `system-${provider}`,
          connection_slug: row?.slug ?? provider,
        },
        fundingTier: (id ? 'tenant' : 'platform') as 'tenant' | 'platform',
        connectionId: id ?? `system-${provider}`,
      };
    }),
  };
  const service = new TtsAgentResolverService(agents as never, assignments as never, aiModelRepository as never, connections as never, credentials as never);
  return { service, credentials };
}

describe('TASK-958 (TTS) — provider_overrides is keyed by connectionKey', () => {
  it('two azure candidates on two connections carry DIFFERENT keys and two distinct credentials', async () => {
    const h = harness({ [AZURE_1]: { slug: 'azure', key: 'key-one' }, [AZURE_2]: { slug: 'azure-research', key: 'key-two' } });
    const resolved = await h.service.resolveFromAgent(
      agent([
        model({ sourceConnectionId: AZURE_1 }),
        model({ role: 'fallback', priority: 0, slug: 'azure-neural-voices-research', sourceConnectionId: AZURE_2 }),
      ]),
      TENANT,
    );

    expect(resolved.spec.primary.connectionKey).toBe('azure');
    expect(resolved.spec.fallback.chain).toHaveLength(1);
    expect(resolved.spec.fallback.chain[0].connectionKey).toBe('azure:azure-research');
    expect(Object.keys(resolved.providerOverrides ?? {}).sort()).toEqual(['azure', 'azure:azure-research']);
    expect(resolved.providerOverrides?.['azure'].api_key).toBe('key-one');
    expect(resolved.providerOverrides?.['azure:azure-research'].api_key).toBe('key-two');
  });

  it('the connection block names the row that answered', async () => {
    const h = harness({ [AZURE_2]: { slug: 'azure-research', key: 'key-two' } });
    const resolved = await h.service.resolveFromAgent(agent([model({ sourceConnectionId: AZURE_2 })]), TENANT);
    expect(resolved.spec.primary.connection).toMatchObject({ provider: 'azure', connectionId: AZURE_2, connectionSlug: 'azure-research' });
  });

  it('a platform/default candidate keys by the ENGINE name, so the payload is byte-identical to a pre-958 one', async () => {
    const h = harness({});
    const resolved = await h.service.resolveFromAgent(agent([model({ tenantId: SYSTEM_TENANT_ID, sourceConnectionId: null })]), TENANT);
    expect(Object.keys(resolved.providerOverrides ?? {})).toEqual(['azure']);
    expect(resolved.spec.primary.connectionKey).toBe('azure');
    expect(h.credentials.resolve).toHaveBeenCalledWith('tts', 'azure', TENANT);
  });
});
