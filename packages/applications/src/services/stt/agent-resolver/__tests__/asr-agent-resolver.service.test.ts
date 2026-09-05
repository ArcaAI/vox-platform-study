/**
 * TASK-861 — AsrAgentResolverService: explicit slug → assignment cascade → ResolvedAsrSpec,
 * with the fallback agent resolved by slug, cloud credentials folded through TASK-862's
 * ProviderCredentialResolver, 404-over-403 preserved, and an unrunnable agent failing closed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { QuotaExceededException } from '@arcaai/exceptions';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderVetoedException } from '../../../ai-provider-connection/provider-vetoed.exception';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<
  string,
  { input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null } }
>;
const platformAgent = fixture.platformDefault.input.agent;
const cloudAgent = fixture.cloudWithAgentFallback.input.agent;
const cloudFallbackAgent = fixture.cloudWithAgentFallback.input.fallbackAgent as ResolvedAgent;

const TENANT = '50000000-0000-0000-0000-000000000000';
const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };

const make = (withCredentials = true) => new AsrAgentResolverService(agents as never, withCredentials ? (credentials as never) : undefined);

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
});

describe('AsrAgentResolverService.resolve — selection', () => {
  it('explicit slug → resolves a SPEECH_TO_TEXT agent by slug and returns its spec (runtimeKey = agent version id)', async () => {
    agents.resolve.mockResolvedValueOnce({ ...platformAgent, source: 'explicit' });
    const { spec } = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: 'platform-transcription',
      departmentId: null,
    });
    expect(spec.runtimeKey).toBe(platformAgent.agentVersionId);
    expect(spec.agent.source).toBe('explicit');
    expect(spec.models.asr.slug).toBe('arcaai-whisper-large-ml-en-gguf');
  });

  it('no slug → the assignment cascade (department → tenant → SYSTEM) through the ONE agent resolver', async () => {
    agents.resolve.mockResolvedValueOnce(platformAgent);
    const { spec } = await make().resolve({ tenantId: TENANT, departmentId: 'dept-1' });
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: null, departmentId: 'dept-1' });
    expect(spec.agent.source).toBe('platform-default');
  });

  it('foreign / unknown / unpublished slug → the agent resolver’s one 404 propagates untouched (404-over-403)', async () => {
    agents.resolve.mockRejectedValueOnce(new NotFoundException('Agent not found'));
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'not-mine' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an agent that resolved no primary ASR model fails CLOSED with a 409 — never a guessed engine', async () => {
    agents.resolve.mockResolvedValueOnce({ ...platformAgent, models: platformAgent.models.filter((m) => m.role !== 'primary') });
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AsrAgentResolverService.resolve — fallback', () => {
  it('parameters.fallback.agentSlug → the fallback agent is resolved by slug (same tenant scope) and embedded as kind=agent', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    const { spec } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(agents.resolve).toHaveBeenNthCalledWith(2, {
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: 'platform-transcription',
      departmentId: null,
    });
    expect(spec.fallback.kind).toBe('agent');
    expect(spec.fallback.spec?.runtimeKey).toBe(cloudFallbackAgent.agentVersionId);
    expect(spec.fallback.autoSwitch).toBe(false);
    expect(spec.fallback.switchAfterConsecutiveFailures).toBe(3);
  });

  it('a fallback agent that cannot be resolved degrades to the model chain / none — resilience config never blocks the primary', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockRejectedValueOnce(new NotFoundException('Agent not found'));
    const { spec } = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(spec.fallback.kind).toBe('none');
    expect(spec.fallback.spec).toBeNull();
  });

  it('no fallback slug → the agent’s own AgentModelFallback chain (kind=model)', async () => {
    agents.resolve.mockResolvedValueOnce(platformAgent);
    const { spec } = await make().resolve({ tenantId: TENANT });
    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(spec.fallback.kind).toBe('model');
    expect(spec.fallback.spec?.models.asr.slug).toBe('faster-whisper-large-v3-turbo-int8');
  });
});

describe('AsrAgentResolverService.resolve — cloud credentials (TASK-862 ProviderCredentialResolver)', () => {
  it('a cloud primary → provider_overrides[provider] from the (stt, provider, tenant) resolver + funding tier; the spec itself stays credential-free', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    credentials.resolve.mockResolvedValueOnce({
      override: { api_key: 'k-azure', funding: 'tenant', region: 'eastus' },
      fundingTier: 'tenant',
      connectionId: 'conn-1',
    });
    const result = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(credentials.resolve).toHaveBeenCalledWith('stt', 'azure-speech', TENANT);
    expect(result.providerOverrides).toEqual({ 'azure-speech': { api_key: 'k-azure', funding: 'tenant', region: 'eastus' } });
    expect(result.fundingTier).toBe('tenant');
    expect(JSON.stringify(result.spec)).not.toContain('k-azure');
  });

  it('a self-hosted primary never consults the credential resolver', async () => {
    agents.resolve.mockResolvedValueOnce(platformAgent);
    const result = await make().resolve({ tenantId: TENANT });
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(result.providerOverrides).toBeUndefined();
    expect(result.fundingTier).toBeUndefined();
  });

  it('no credential at either tier → no override entry (the runtime proceeds on platform env creds, as before)', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    credentials.resolve.mockResolvedValueOnce(null);
    const result = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(result.providerOverrides).toBeUndefined();
  });

  it('a tenant VETO on the provider fails closed (409) — never another tier, never another provider', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    credentials.resolve.mockRejectedValueOnce(new ProviderVetoedException('stt', 'azure-speech', TENANT));
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' })).rejects.toBeInstanceOf(ProviderVetoedException);
  });

  // TASK-874 — the funding of the engine that SERVED decides BYOK vs CLOUD, and
  // fallback to the platform default is a metered platform HA capability. The
  // per-engine truth is `providerOverrides[provider].funding`; the `fundingTier`
  // scalar is the PRIMARY engine's alone and must never be a first-resolved-wins
  // stand-in for whichever engine happened to contribute a credential.
  it('local primary + cloud PLATFORM fallback → the fallback’s platform funding rides on its own override entry, and fundingTier stays undefined (the primary has no credential)', async () => {
    const localPrimaryWithCloudFallback = {
      ...platformAgent,
      compiledConfig: {
        ...platformAgent.compiledConfig,
        parameters: {
          ...platformAgent.compiledConfig.parameters,
          fallback: { agentSlug: 'clinic-azure-transcription', autoSwitch: true, switchAfterConsecutiveFailures: 2 },
        },
      },
    } as ResolvedAgent;
    agents.resolve.mockResolvedValueOnce(localPrimaryWithCloudFallback).mockResolvedValueOnce(cloudAgent);
    credentials.resolve.mockResolvedValueOnce({
      override: { api_key: 'k-platform', funding: 'platform', region: 'eastus' },
      fundingTier: 'platform',
      connectionId: 'conn-sys',
    });

    const result = await make().resolve({ tenantId: TENANT });

    expect(credentials.resolve).toHaveBeenCalledExactlyOnceWith('stt', 'azure-speech', TENANT);
    expect(result.providerOverrides?.['azure-speech']?.funding).toBe('platform');
    // The primary is a self-hosted engine: it has no credential and therefore no
    // funding tier. Reporting the fallback's tier here is the mis-billing trap.
    expect(result.fundingTier).toBeUndefined();
  });

  it('cloud BYO primary + cloud PLATFORM fallback → each engine carries its OWN derived funding, and fundingTier is the primary’s', async () => {
    const sarvamFallbackAgent = {
      ...cloudAgent,
      slug: 'platform-sarvam-transcription',
      agentVersionId: '0199a861-0000-7000-8000-000000000021',
      models: cloudAgent.models.map((m) =>
        m.role === 'primary' ? { ...m, slug: 'sarvam-saarika-v2', format: 'SARVAM', provider: 'sarvam', sourceUri: 'sarvam://saarika' } : m,
      ),
      compiledConfig: { ...cloudAgent.compiledConfig, parameters: { ...cloudAgent.compiledConfig.parameters, fallback: {} } },
    } as ResolvedAgent;
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(sarvamFallbackAgent);
    credentials.resolve.mockImplementation(async (_service: string, provider: string) =>
      provider === 'azure-speech'
        ? { override: { api_key: 'k-azure', funding: 'tenant', region: 'eastus' }, fundingTier: 'tenant', connectionId: 'conn-byo' }
        : {
            override: { api_key: 'k-sarvam', funding: 'platform', base_url: 'https://api.sarvam.ai' },
            fundingTier: 'platform',
            connectionId: 'conn-sys',
          },
    );

    const result = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    expect(result.providerOverrides?.['azure-speech']?.funding).toBe('tenant');
    expect(result.providerOverrides?.['sarvam']?.funding).toBe('platform');
    expect(result.fundingTier).toBe('tenant');
  });

  it('without the credential resolver wired, the agent resolver’s own providerOverride is used', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    const result = await make(false).resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(result.providerOverrides).toEqual({ 'azure-speech': { api_key: 'REDACTED-NEVER-IN-SPEC', funding: 'tenant', region: 'eastus' } });
    expect(result.fundingTier).toBe('tenant');
  });
});

describe('AsrAgentResolverService.resolveProviderOverrides — the batch-worker whole-service pull (TASK-861 follow-up)', () => {
  const binding = (funding: 'tenant' | 'platform', override: Record<string, unknown>) => ({
    override: { funding, ...override },
    fundingTier: funding,
    connectionId: `conn-${funding}`,
  });

  it('resolves every cloud STT provider through the ONE resolver: the tenant’s row → tenant, the SYSTEM default → platform, no row → no key', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'azure-speech') return binding('tenant', { api_key: 'k-azure', region: 'eastus' });
      if (provider === 'sarvam') return binding('platform', { api_key: 'k-sarvam', base_url: 'https://api.sarvam.ai', model: 'saarika:v2' });
      return null; // azure-foundry, openai: no row at either tier
    });
    const out = await make().resolveProviderOverrides(TENANT);
    expect(credentials.resolve.mock.calls).toEqual([
      ['stt', 'azure-speech', TENANT],
      ['stt', 'azure-foundry', TENANT],
      ['stt', 'sarvam', TENANT],
      ['stt', 'openai', TENANT],
    ]);
    expect(out).toEqual({
      'azure-speech': { api_key: 'k-azure', funding: 'tenant', region: 'eastus' },
      sarvam: { api_key: 'k-sarvam', funding: 'platform', base_url: 'https://api.sarvam.ai', model: 'saarika:v2' },
    });
    // A credential pull, not a selection: the agent resolver is never consulted.
    expect(agents.resolve).not.toHaveBeenCalled();
  });

  it('a veto (DISABLED tenant row) leaves THAT provider out — no tier serves it — while the others still resolve', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'sarvam') throw new ProviderVetoedException('stt', 'sarvam', TENANT);
      if (provider === 'azure-foundry') return null; // the seeded SYSTEM veto row: no tier serves it
      return binding('platform', { api_key: `k-${provider}` });
    });
    const out = await make().resolveProviderOverrides(TENANT);
    expect(Object.keys(out).sort()).toEqual(['azure-speech', 'openai']);
    expect(credentials.resolve).toHaveBeenCalledTimes(4);
  });

  it('an entitlement refusal of the platform default leaves that provider out — never a substituted credential', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'openai') {
        throw new QuotaExceededException('not entitled', { capability: 'platformDefaultCredential', limit: 0, used: 0, requested: 1 });
      }
      if (provider === 'azure-foundry') return null;
      return binding('tenant', { api_key: `k-${provider}` });
    });
    const out = await make().resolveProviderOverrides(TENANT);
    expect(Object.keys(out).sort()).toEqual(['azure-speech', 'sarvam']);
  });

  it('a backend fault propagates — it is never disguised as "no credential"', async () => {
    credentials.resolve.mockRejectedValueOnce(new Error('vault transit unavailable'));
    await expect(make().resolveProviderOverrides(TENANT)).rejects.toThrow('vault transit unavailable');
  });

  it('without the credential resolver wired it fails closed (503) — never an empty map', async () => {
    await expect(make(false).resolveProviderOverrides(TENANT)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
