/**
 * TASK-958 D-4 — the ASR wire learns WHICH account of a vendor a chain spends.
 *
 * `apps/stt`'s cloud loaders read `provider_overrides` under a flat key, so with two
 * connections of one vendor the provider id can no longer select an entry: the
 * fallback chain would authenticate with the key that just failed. `AsrSpecCore`
 * carries `connectionKey` / `connectionId` / `connectionSlug` (they sit on the CORE
 * so they cover the primary AND the fallback core), and `provider_overrides` is
 * keyed by `connectionKey` — which equals the provider id for a default or platform
 * row, so every pre-958 payload is byte-identical.
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
const OPENAI_1 = 'conn-openai-clinic';
const OPENAI_2 = 'conn-openai-research';

const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const make = () => new AsrAgentResolverService(agents as never, credentials as never);

/** Bind an agent's PRIMARY asr model to a connection. */
function bind(agent: ResolvedAgent, connectionId: string | null, provider = 'openai'): ResolvedAgent {
  return {
    ...agent,
    models: agent.models.map((m) => (m.role === 'primary' ? { ...m, provider, ...(connectionId ? { sourceConnectionId: connectionId } : {}) } : m)),
  };
}

const byId: Record<string, { slug: string; key: string }> = {
  [OPENAI_1]: { slug: 'openai', key: 'key-one' },
  [OPENAI_2]: { slug: 'openai-research', key: 'key-two' },
};

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockImplementation(async (_s: string, provider: string, _t: string, options?: { connectionId?: string }) => {
    const row = options?.connectionId ? byId[options.connectionId] : undefined;
    if (options?.connectionId && !row) return null;
    return {
      override: {
        api_key: row?.key ?? 'platform-key',
        funding: (row ? 'tenant' : 'platform') as 'tenant' | 'platform',
        connection_id: options?.connectionId ?? `system-${provider}`,
        connection_slug: row?.slug ?? provider,
      },
      fundingTier: (row ? 'tenant' : 'platform') as 'tenant' | 'platform',
      connectionId: options?.connectionId ?? `system-${provider}`,
    };
  });
});

describe('TASK-958 (ASR) — the core names its connection and provider_overrides is keyed by it', () => {
  it('the primary core and the fallback core carry their OWN connection, and the map holds two entries', async () => {
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, OPENAI_1)).mockResolvedValueOnce(bind(cloudFallbackAgent, OPENAI_2));
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    expect(spec.connectionKey).toBe('openai');
    expect(spec.connectionId).toBe(OPENAI_1);
    expect(spec.connectionSlug).toBe('openai');
    expect(spec.fallback.spec?.connectionKey).toBe('openai-research');
    expect(spec.fallback.spec?.connectionId).toBe(OPENAI_2);
    expect(Object.keys(providerOverrides ?? {}).sort()).toEqual(['openai', 'openai-research']);
    expect(providerOverrides?.['openai'].api_key).toBe('key-one');
    expect(providerOverrides?.['openai-research'].api_key).toBe('key-two');
  });

  it('an unbound (SYSTEM catalogue) core keys by the PROVIDER id — the pre-958 payload — while still naming the row that answered', async () => {
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, null)).mockResolvedValueOnce(bind(cloudFallbackAgent, null));
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    // Three arguments, so an unbound resolve stays indistinguishable from the pre-958 one…
    expect(credentials.resolve).toHaveBeenCalledWith('stt', 'openai', TENANT);
    // …and the credential map keeps its one provider-named entry.
    expect(Object.keys(providerOverrides ?? {})).toEqual(['openai']);
    // The cascade still resolved a REAL row (the tenant's default, or the platform's),
    // and D-7 needs its id to attribute the spend, so the core names it — with
    // `connectionKey === provider`, which is what leaves the wire key unchanged.
    expect(spec.connectionKey).toBe('openai');
    expect(spec.connectionId).toBe('system-openai');
  });

  it('a core with no cloud credential at all carries NO connection fields (omitted, never nulled)', async () => {
    // The platform-default fixture is self-hosted whisper.cpp: nothing to authenticate
    // as, so the three optionals must be absent rather than `null` — `apps/stt`'s
    // mirror is `extra='forbid'` and reads absence as "no opinion".
    const selfHosted = fixture.platformDefault.input.agent;
    agents.resolve.mockResolvedValueOnce(selfHosted);
    const { spec, providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(spec).not.toHaveProperty('connectionKey');
    expect(spec).not.toHaveProperty('connectionId');
    expect(spec).not.toHaveProperty('connectionSlug');
    expect(providerOverrides).toBeUndefined();
  });

  it('a disabled named connection leaves that chain without a credential rather than lending it the default key', async () => {
    agents.resolve.mockResolvedValueOnce(bind(cloudAgent, OPENAI_1)).mockResolvedValueOnce(bind(cloudFallbackAgent, 'conn-disabled'));
    const { providerOverrides } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(Object.keys(providerOverrides ?? {})).toEqual(['openai']);
  });
});
