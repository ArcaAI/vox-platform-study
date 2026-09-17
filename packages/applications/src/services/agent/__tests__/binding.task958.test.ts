/**
 * TASK-958 D-3 — "the model row names the connection."
 *
 * A tenant may now hold several `AiProviderConnection` rows for one
 * `(service, provider)`, so the provider NAME no longer identifies an account. The
 * binding a tenant admin actually makes is `AiModel.sourceConnectionId` — the FK
 * TASK-890 already wrote at declaration time — and this suite pins what the text
 * resolver does with it:
 *
 *  - a model that NAMES a connection resolves THAT connection by id (15);
 *  - a named connection that is disabled or keyless makes THAT candidate
 *    unusable — the chain walks on, it never widens to the tenant's default (15b);
 *  - an id outside the two tiers this tenant may read is the house 404 (15c);
 *  - two candidates on two accounts of ONE vendor are DIFFERENT endpoints, so the
 *    chain keeps both instead of de-duping them into a retry (16);
 *  - a SYSTEM catalogue row (`sourceConnectionId === null`) still resolves through
 *    the provider-name cascade, byte-for-byte as before (17).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { TextAgentResolverService } from '../text-agent-resolver.service';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';
const CONNECTION_1 = 'conn-openai-default';
const CONNECTION_2 = 'conn-openai-research';

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel =>
  ({
    role: 'primary',
    slug: 'openai-gpt-5-4-mini',
    sourceUri: 'gpt-5.4-mini',
    sourceRevision: null,
    localPath: null,
    checksum: null,
    wireModelId: 'gpt-5.4-mini',
    format: 'API',
    computeType: null,
    provider: 'openai',
    tenantId: TENANT,
    ...over,
  }) as ResolvedAgentModel;

const agent = (models: ResolvedAgentModel[]): ResolvedAgent => ({
  agentId: 'agent-1',
  agentVersionId: 'agent-1',
  slug: 'clinic-summarizer',
  versionNumber: 1,
  task: AgentTask.TEXT_GENERATION,
  tenantId: TENANT,
  source: 'tenant',
  compiledConfig: {
    task: AgentTask.TEXT_GENERATION,
    service: 'llm',
    model: { id: 'm1', slug: models[0].slug, provider: models[0].provider, taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: { source: 'inline', content: 'be brief' },
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
  },
  models,
  guardrail: { enabled: true },
});

const agents = { resolve: vi.fn() };
const assignments = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const make = (): TextAgentResolverService => new TextAgentResolverService(agents as never, assignments as never, credentials as never);

/** One override entry per connection id — what `ProviderCredentialResolver` returns for a by-id resolve. */
const bindingFor = (connectionId: string, key: string, baseUrl: string) => ({
  override: { api_key: key, funding: 'tenant' as const, base_url: baseUrl, connection_id: connectionId, connection_slug: connectionId },
  fundingTier: 'tenant' as const,
  connectionId,
});

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
  assignments.resolve.mockResolvedValue({ agentSlug: 'clinic-summarizer', source: 'tenant' });
  agents.resolve.mockImplementation(async () => {
    throw new NotFoundException('Agent not found');
  });
});

describe('TASK-958 (15) — a model that names a connection resolves THAT connection', () => {
  it('the candidate carries connection #2 and its override entry', async () => {
    agents.resolve.mockResolvedValue(agent([model({ sourceConnectionId: CONNECTION_2 })]));
    credentials.resolve.mockImplementation(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) =>
      options?.connectionId === CONNECTION_2 ? bindingFor(CONNECTION_2, 'key-two', 'https://two.openai.test') : null,
    );

    const spec = await make().resolve({ tenantId: TENANT });

    expect(credentials.resolve).toHaveBeenCalledWith('llm', 'openai', TENANT, { connectionId: CONNECTION_2 });
    expect(spec.primary.providerOverride?.connection_id).toBe(CONNECTION_2);
    expect(spec.primary.providerOverride?.api_key).toBe('key-two');
  });
});

describe('TASK-958 (15b) — a disabled named connection makes that candidate unusable', () => {
  it('the fallback bound to the disabled sibling is skipped and the chain continues', async () => {
    agents.resolve.mockResolvedValue(
      agent([
        model({ sourceConnectionId: CONNECTION_1 }),
        model({ role: 'fallback', priority: 0, slug: 'research-gpt', sourceConnectionId: CONNECTION_2 }),
        model({ role: 'fallback', priority: 1, slug: 'platform-gemma', provider: 'lm-studio', wireModelId: 'gemma-4', tenantId: SYSTEM_TENANT_ID, sourceConnectionId: null }),
      ]),
    );
    // #2 is disabled ⇒ `null`, which must NOT widen to the tenant's default.
    credentials.resolve.mockImplementation(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) =>
      options?.connectionId === CONNECTION_1 ? bindingFor(CONNECTION_1, 'key-one', 'https://one.openai.test') : null,
    );

    const spec = await make().resolve({ tenantId: TENANT });

    expect(spec.primary.providerOverride?.connection_id).toBe(CONNECTION_1);
    expect(spec.fallback.chain.map((c) => c.modelSlug)).toEqual(['platform-gemma']);
  });

  it('a PRIMARY bound to a disabled connection fails CLOSED rather than spending the default key', async () => {
    agents.resolve.mockResolvedValue(agent([model({ sourceConnectionId: CONNECTION_2 })]));
    credentials.resolve.mockResolvedValue(null);
    await expect(make().resolve({ tenantId: TENANT })).rejects.toMatchObject({
      response: { code: 'TEXT_AGENT_UNRUNNABLE' },
    });
  });
});

describe('TASK-958 (15c) — a foreign connection id is the house 404', () => {
  it('propagates the resolver 404 rather than widening to the default', async () => {
    agents.resolve.mockResolvedValue(agent([model({ sourceConnectionId: 'someone-elses-connection' })]));
    credentials.resolve.mockRejectedValue(new NotFoundException("No connection row 'someone-elses-connection' for provider 'openai' (service 'llm')."));
    await expect(make().resolve({ tenantId: TENANT })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TASK-958 (16) — two accounts of one vendor are two ENDPOINTS', () => {
  it('a chain [model@#1, model@#2] keeps both candidates', async () => {
    agents.resolve.mockResolvedValue(
      agent([
        model({ sourceConnectionId: CONNECTION_1 }),
        model({ role: 'fallback', priority: 0, slug: 'openai-gpt-5-4-mini-research', sourceConnectionId: CONNECTION_2 }),
      ]),
    );
    credentials.resolve.mockImplementation(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) =>
      options?.connectionId === CONNECTION_2
        ? bindingFor(CONNECTION_2, 'key-two', 'https://two.openai.test')
        : bindingFor(CONNECTION_1, 'key-one', 'https://one.openai.test'),
    );

    const spec = await make().resolve({ tenantId: TENANT });

    expect(spec.fallback.chain).toHaveLength(1);
    expect(spec.fallback.chain[0].providerOverride?.connection_id).toBe(CONNECTION_2);
    expect(spec.primary.providerOverride?.connection_id).toBe(CONNECTION_1);
  });

  it('…and keeps them even when the two accounts share a base_url and a model id (the id is the whole difference)', async () => {
    agents.resolve.mockResolvedValue(
      agent([
        model({ sourceConnectionId: CONNECTION_1 }),
        model({ role: 'fallback', priority: 0, slug: 'openai-gpt-5-4-mini-research', sourceConnectionId: CONNECTION_2 }),
      ]),
    );
    credentials.resolve.mockImplementation(async (_s: string, _p: string, _t: string, options?: { connectionId?: string }) =>
      bindingFor(options?.connectionId ?? CONNECTION_1, 'k', 'https://api.openai.com/v1'),
    );

    const spec = await make().resolve({ tenantId: TENANT });
    expect(spec.fallback.chain).toHaveLength(1);
    expect(spec.fallback.chain[0].providerOverride?.connection_id).toBe(CONNECTION_2);
  });
});

describe('TASK-958 (17) — a SYSTEM catalogue row still resolves through the DEFAULT connection', () => {
  it('no `sourceConnectionId` ⇒ the by-provider cascade, called with no options (unchanged behaviour)', async () => {
    agents.resolve.mockResolvedValue(agent([model({ tenantId: SYSTEM_TENANT_ID, sourceConnectionId: null })]));
    credentials.resolve.mockResolvedValue(bindingFor(CONNECTION_1, 'default-key', 'https://api.openai.com/v1'));

    const spec = await make().resolve({ tenantId: TENANT });

    expect(credentials.resolve).toHaveBeenCalledWith('llm', 'openai', TENANT);
    expect(spec.primary.providerOverride?.connection_id).toBe(CONNECTION_1);
  });
});
