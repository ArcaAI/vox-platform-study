/**
 * TASK-1021 L1.4 (C-5) — an ASR agent whose primary model is served by the platform's OWN vLLM
 * engine (`provider: 'vllm'`) reaches `apps/stt` with a `provider_overrides["vllm"]` entry naming
 * WHERE that engine lives (`base_url`) and HOW MUCH it may take (`max_concurrent`), read off the
 * SYSTEM `stt/vllm` connection row.
 *
 * Before TASK-1021 the chain gate admitted cloud BYO providers only, so a self-host engine got no
 * entry at all. `vllm` is a PLATFORM self-host provider: a tenant row can never serve it, the
 * platform-default entitlement never suppresses it, and the spec itself stays credential-free.
 *
 * Real `AiProviderConnectionService.toOverrideEntry` + real `ProviderCredentialResolver` over a
 * fake repository, so the override builder is exercised, not mocked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { AiProviderConnectionService } from '../../../ai-provider-connection/ai-provider-connection.service';
import { PLATFORM_SELF_HOST_PROVIDERS, isPlatformSelfHostProvider } from '../../../ai-provider-connection/constants';
import { ProviderCredentialResolver } from '../../../ai-provider-connection/provider-credential-resolver';
import { withTask958Lookups } from '../../../ai-provider-connection/__tests__/task958-repo-lookups';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent } }>;

const TENANT = 'a0000000-0000-0000-0000-00000000000a';
const BASE_URL = 'http://hope-vllm-asr:8867/v1';

/** The Global spike agent, its primary bound to the vLLM-served row (D-13: `provider: 'vllm'`). */
function vllmAgent(): ResolvedAgent {
  const agent = structuredClone(fixture.vllmServingFacts.input.agent);
  return { ...agent, models: agent.models.map((m) => (m.role === 'primary' ? { ...m, provider: 'vllm', libraryName: 'vllm' } : m)) };
}

function systemVllmRow(overrides: Record<string, unknown> = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'vllm',
    slug: 'vllm',
    isDefault: true,
    baseUrl: BASE_URL,
    maxConcurrent: 32,
    enabled: true,
    encryptedApiKey: Buffer.from('vault:v1:placeholder', 'utf8'),
    keyVersion: 1,
    extraJson: null,
    ...overrides,
  } as never);
}

function makeResolver(rowsByTenant: Record<string, unknown[]>, entitled = false) {
  const repo = withTask958Lookups({
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).find((r) => r.service === service && r.provider === provider) ?? null,
    ),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) => ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service)),
    findDeletedByTenantServiceProvider: vi.fn(async () => null),
  });
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : undefined)) };
  const secrets = { decrypt: vi.fn(async () => Buffer.from('self-host-placeholder', 'utf8')), supportsTransit: vi.fn(() => true) };
  // Unentitled by default: the platform-default gate governs VENDOR spend and must not touch a
  // self-host engine.
  const entitlements = { isFeatureEnabled: vi.fn(async () => entitled), assertQuantityQuota: vi.fn() };
  const connections = new AiProviderConnectionService(repo as any, { baseClient: {} } as any, { emit: vi.fn() } as any, cls as any, secrets as any, entitlements as any);
  vi.spyOn((connections as any).logger, 'warn').mockImplementation(() => undefined);
  const agents = { resolve: vi.fn(async () => vllmAgent()) };
  return new AsrAgentResolverService(agents as never, new ProviderCredentialResolver(connections));
}

beforeEach(() => vi.clearAllMocks());

describe('TASK-1021 — the self-host vLLM engine on the ASR credential plane', () => {
  it('declares vllm as the platform`s own STT serving engine', () => {
    expect(PLATFORM_SELF_HOST_PROVIDERS.stt).toEqual(['vllm']);
    expect(isPlatformSelfHostProvider('stt', 'vllm')).toBe(true);
  });

  it('an agent whose primary is provider vllm gets providerOverrides.vllm with base_url and max_concurrent', async () => {
    const session = await makeResolver({ [SYSTEM_TENANT_ID]: [systemVllmRow()] }).resolve({ tenantId: TENANT, agentSlug: 'realtime-transcription-vllm' });

    expect(session.providerOverrides?.vllm).toMatchObject({ base_url: BASE_URL, max_concurrent: 32, funding: 'platform', connection_slug: 'vllm' });
    expect(session.providerOverrides?.vllm.connection_id).toEqual(expect.any(String));
    expect(session.fundingTier).toBe('platform');
  });

  it('the spec itself stays credential-free', async () => {
    const session = await makeResolver({ [SYSTEM_TENANT_ID]: [systemVllmRow()] }).resolve({ tenantId: TENANT, agentSlug: 'realtime-transcription-vllm' });
    const wire = JSON.stringify(session.spec);
    expect(wire).not.toContain('self-host-placeholder');
    expect(wire).not.toContain('api_key');
    expect(wire).not.toContain(BASE_URL);
  });

  it('a row with no maxConcurrent carries no max_concurrent key (the engine default applies)', async () => {
    const session = await makeResolver({ [SYSTEM_TENANT_ID]: [systemVllmRow({ maxConcurrent: null })] }).resolve({ tenantId: TENANT, agentSlug: 'realtime-transcription-vllm' });
    expect(session.providerOverrides?.vllm.base_url).toBe(BASE_URL);
    expect(session.providerOverrides?.vllm).not.toHaveProperty('max_concurrent');
  });

  it('a TENANT row can never serve a self-host engine — only the SYSTEM row does', async () => {
    const tenantRow = systemVllmRow({ tenantId: TENANT, baseUrl: 'http://attacker.invalid/v1' });
    const session = await makeResolver({ [TENANT]: [tenantRow], [SYSTEM_TENANT_ID]: [systemVllmRow()] }).resolve({ tenantId: TENANT, agentSlug: 'realtime-transcription-vllm' });
    expect(session.providerOverrides?.vllm.base_url).toBe(BASE_URL);
  });

  it('the batch worker`s whole-service pull carries the vllm entry too', async () => {
    const overrides = await makeResolver({ [SYSTEM_TENANT_ID]: [systemVllmRow()] }).resolveProviderOverrides(TENANT);
    expect(overrides.vllm).toMatchObject({ base_url: BASE_URL, max_concurrent: 32, funding: 'platform' });
  });
});
