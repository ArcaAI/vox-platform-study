/**
 * TASK-861 — AsrAgentResolverService: explicit slug → assignment cascade → ResolvedAsrSpec,
 * with the fallback agent resolved by slug, cloud credentials folded through TASK-862's
 * ProviderCredentialResolver, 404-over-403 preserved, and an unrunnable agent failing closed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderVetoedException } from '../../../ai-provider-connection/provider-vetoed.exception';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null } }>;
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
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription', departmentId: null });
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
    expect(agents.resolve).toHaveBeenNthCalledWith(2, { tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription', departmentId: null });
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
    credentials.resolve.mockResolvedValueOnce({ override: { api_key: 'k-azure', funding: 'tenant', region: 'eastus' }, fundingTier: 'tenant', connectionId: 'conn-1' });
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

  it('without the credential resolver wired, the agent resolver’s own providerOverride is used', async () => {
    agents.resolve.mockResolvedValueOnce(cloudAgent).mockResolvedValueOnce(cloudFallbackAgent);
    const result = await make(false).resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(result.providerOverrides).toEqual({ 'azure-speech': { api_key: 'REDACTED-NEVER-IN-SPEC', funding: 'tenant', region: 'eastus' } });
    expect(result.fundingTier).toBe('tenant');
  });
});
