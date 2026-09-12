/**
 * TASK-958 G2a — the review findings on the ASR half of the wire.
 *
 * F6 — the override key is `provider` for a DEFAULT/SYSTEM row and `provider:slug`
 *      for a named sibling, so a slug can never alias another provider's entry.
 * F7 — a sibling binding that FAILS CLOSED (disabled / keyless) must still name
 *      itself on the core, with NO entry in the map: `apps/stt` then reads the
 *      declared key, misses, and refuses — instead of falling back to the provider
 *      key and spending the tenant's DEFAULT account.
 * F8 — the batch worker's whole-tenant credential pull must contain the siblings
 *      too, or a sibling-bound job silently transcribes on the default resource.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedAgent } from '@arcaai/types';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null } }>;
const cloudAgent = fixture.cloudWithAgentFallback.input.agent;
const cloudFallbackAgent = fixture.cloudWithAgentFallback.input.fallbackAgent as ResolvedAgent;

const TENANT = '50000000-0000-0000-0000-000000000000';

type Row = { id: string; slug: string; provider: string; isDefault: boolean; key: string; enabled?: boolean };

const ROWS: Row[] = [
  { id: 'conn-openai-1', slug: 'openai', provider: 'openai', isDefault: true, key: 'key-default' },
  { id: 'conn-openai-2', slug: 'openai-research', provider: 'openai', isDefault: false, key: 'key-sibling' },
  { id: 'conn-openai-3', slug: 'openai-disabled', provider: 'openai', isDefault: false, key: 'key-disabled', enabled: false },
];

const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const connections = { list: vi.fn() };

const make = () => new AsrAgentResolverService(agents as never, credentials as never, connections as never);

/** Bind an agent's PRIMARY asr model to a connection. */
function bind(agent: ResolvedAgent, connectionId: string | null, provider = 'openai'): ResolvedAgent {
  return {
    ...agent,
    models: agent.models.map((m) => (m.role === 'primary' ? { ...m, provider, ...(connectionId ? { sourceConnectionId: connectionId } : {}) } : m)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connections.list.mockImplementation(async () =>
    ROWS.map((r) => ({ id: r.id, slug: r.slug, provider: r.provider, isDefault: r.isDefault, enabled: r.enabled ?? true, hasKey: true })),
  );
  credentials.resolve.mockImplementation(async (_s: string, provider: string, _t: string, options?: { connectionId?: string }) => {
    // By NAME the cascade can only ever answer with the tenant's DEFAULT row (B1), or
    // with the platform's when the tenant holds none.
    const rows = (await connections.list()) as Array<{ id: string }>;
    const row = options?.connectionId
      ? ROWS.find((r) => r.id === options.connectionId)
      : ROWS.find((r) => r.provider === provider && r.isDefault && rows.some((known) => known.id === r.id));
    if (options?.connectionId && (!row || row.enabled === false)) return null;
    return {
      override: {
        api_key: row?.key ?? 'platform-key',
        funding: (row ? 'tenant' : 'platform') as 'tenant' | 'platform',
        connection_id: options?.connectionId ?? row?.id ?? `system-${provider}`,
        connection_slug: row?.slug ?? provider,
      },
      fundingTier: (row ? 'tenant' : 'platform') as 'tenant' | 'platform',
      connectionId: options?.connectionId ?? row?.id ?? `system-${provider}`,
    };
  });
});

describe('TASK-958 F6/F7 (ASR) — the core names its connection with a namespaced key', () => {
  it('a named sibling is filed under `provider:slug`, never under the bare provider id', async () => {
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, 'conn-openai-1')).mockResolvedValueOnce(bind(cloudFallbackAgent, 'conn-openai-2'));
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    expect(spec.connectionKey).toBe('openai');
    expect(spec.fallback.spec?.connectionKey).toBe('openai:openai-research');
    expect(Object.keys(providerOverrides ?? {}).sort()).toEqual(['openai', 'openai:openai-research']);
    expect(providerOverrides?.['openai'].api_key).toBe('key-default');
    expect(providerOverrides?.['openai:openai-research'].api_key).toBe('key-sibling');
  });

  it('a DISABLED sibling still names itself on the core, and the map carries NO entry for it', async () => {
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, 'conn-openai-1')).mockResolvedValueOnce(bind(cloudFallbackAgent, 'conn-openai-3'));
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    // The declared key is what makes `apps/stt` fail closed on that chain…
    expect(spec.fallback.spec?.connectionKey).toBe('openai:openai-disabled');
    expect(spec.fallback.spec?.connectionId).toBe('conn-openai-3');
    // …because nothing was filed under it.
    expect(Object.keys(providerOverrides ?? {})).toEqual(['openai']);
    expect(providerOverrides?.['openai:openai-disabled']).toBeUndefined();
  });

  it('a failed-closed binding whose row cannot be identified still gets a key that cannot alias the provider entry', async () => {
    connections.list.mockResolvedValue([]);
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, 'conn-openai-1')).mockResolvedValueOnce(bind(cloudFallbackAgent, 'conn-gone'));
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(spec.fallback.spec?.connectionKey).toBe('openai:conn-gone');
    expect(Object.keys(providerOverrides ?? {})).toEqual(['openai']);
  });
});

describe('TASK-958 F8 (ASR) — the batch credential pull carries every connection, not only the default', () => {
  it('two connections of one vendor produce two entries, keyed default-then-sibling', async () => {
    const overrides = await make().resolveProviderOverrides(TENANT);
    expect(overrides['openai']?.api_key).toBe('key-default');
    expect(overrides['openai:openai-research']?.api_key).toBe('key-sibling');
    // The DISABLED sibling resolves to nothing and must leave no entry behind.
    expect(overrides['openai:openai-disabled']).toBeUndefined();
  });

  it('a tenant with no rows of its own still gets the platform default under the bare provider id', async () => {
    connections.list.mockResolvedValue([]);
    const overrides = await make().resolveProviderOverrides(TENANT);
    expect(overrides['openai']?.api_key).toBe('platform-key');
    expect(Object.keys(overrides).every((key) => !key.includes(':'))).toBe(true);
  });
});
