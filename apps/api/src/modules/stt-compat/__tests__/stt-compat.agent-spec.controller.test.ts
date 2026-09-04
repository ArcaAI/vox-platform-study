/**
 * TASK-861 — v1-compat `POST api/stt/start_session` on the ASR Agent path.
 *
 * With `AsrAgentResolverService` wired, a session with no explicit `pipelineId`
 * resolves through the agent cascade (or the named `agentSlug`) and the spec goes
 * to STT keyed on its runtime key; the `provider` hint stays a response echo. The
 * deprecated `pipelineId` path keeps working. The `switch` route trusts the runtime
 * (STT 409s when the session declares no fallback) instead of `TenantSttConfig`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SttCompatController } from '../stt-compat.controller';
import type { StartSessionRequest } from '../dto/start-session.request';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'platform-default' },
  models: { asr: { slug: 'whisper' } },
  fallback: { kind: 'model', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: { runtimeKey: 'agent-v-1:fallback:fw', agent: { slug: 'platform-transcription', versionId: 'agent-v-1' }, models: { asr: { slug: 'fw' } } } },
};

const request = (): StartSessionRequest => ({
  session_id: 'session_123456789',
  language: 'en-US',
  provider: 'azure',
  audioSettings: { sampleRate: 16000, format: 'pcm', channels: 1, bitDepth: 16, chunkSize: 1024, noiseSuppression: true, echoCancellation: true, autoGainControl: false },
});

function wire(withResolver = true) {
  const pipelineService = { getAll: vi.fn().mockResolvedValue([{ id: 'azure-pipeline', slug: 'azure-speech', name: 'Azure', tags: ['azure'], isDefault: true }]) };
  const sessionService = {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session_123456789', status: 'active', pipelineId: 'agent-v-1', activeEngine: 'primary' }),
    switchProvider: vi.fn().mockResolvedValue(undefined),
  };
  const sessionBinding = { bind: vi.fn().mockResolvedValue(undefined), bindSessionMeta: vi.fn().mockResolvedValue(undefined), lookup: vi.fn().mockResolvedValue('tenant-1') };
  const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), run: vi.fn((cb: () => Promise<unknown>) => cb()) };
  const apiKeyService = { authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1' }) };
  const sessionMetadata = { setLanguage: vi.fn().mockResolvedValue(undefined) };
  const sttConfig = { getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: null }), resolveProviderOverrides: vi.fn().mockResolvedValue({}) };
  const asrResolver = { resolve: vi.fn().mockResolvedValue({ spec, providerOverrides: { sarvam: { api_key: 'k', funding: 'platform' } } }) };
  const controller = new SttCompatController(
    pipelineService as never, sessionService as never, sessionBinding as never, cls as never, apiKeyService as never,
    sessionMetadata as never, sttConfig as never, withResolver ? (asrResolver as never) : undefined,
  );
  return { controller, pipelineService, sessionService, sttConfig, asrResolver };
}

const headers = { headers: { 'x-api-key': 'legacy-key' } };

describe('SttCompatController.startSession — agent path (TASK-861)', () => {
  it('no pipelineId → the assignment cascade through the resolver; the provider hint no longer selects a pipeline', async () => {
    const { controller, pipelineService, sessionService, asrResolver, sttConfig } = wire();
    const out = await controller.startSession(request(), headers);
    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null });
    expect(pipelineService.getAll).not.toHaveBeenCalled();
    expect(sttConfig.getEffective).not.toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'agent-v-1',
        resolvedSpec: spec,
        fallbackPipelineId: 'agent-v-1:fallback:fw',
        autoSwitchEnabled: true,
        consecutiveFailureThreshold: 2,
        providerOverrides: { sarvam: { api_key: 'k', funding: 'platform' } },
        tenantId: 'tenant-1',
      }),
    );
    expect(out).toMatchObject({ provider: 'azure', pipeline_id: 'agent-v-1', active_engine: 'primary', agent_slug: 'platform-transcription', agent_version_id: 'agent-v-1' });
  });

  it('agentSlug → explicit agent', async () => {
    const { controller, asrResolver } = wire();
    await controller.startSession({ ...request(), agentSlug: 'clinic-azure-transcription' } as StartSessionRequest, headers);
    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: 'clinic-azure-transcription', departmentId: null });
  });

  it('startOn=default with a spec that declares no fallback → 409', async () => {
    const { controller, asrResolver, sessionService } = wire();
    asrResolver.resolve.mockResolvedValueOnce({ spec: { ...spec, fallback: { kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null } } });
    await expect(controller.startSession({ ...request(), startOn: 'default' } as StartSessionRequest, headers)).rejects.toMatchObject({ status: 409 });
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('an explicit pipelineId still takes the deprecated path and never touches the resolver', async () => {
    const { controller, asrResolver, sessionService } = wire();
    await controller.startSession({ ...request(), pipelineId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } as StartSessionRequest, headers);
    expect(asrResolver.resolve).not.toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }));
  });

  it('without the resolver wired the legacy provider selection still serves (degradation, not a guess)', async () => {
    const { controller, pipelineService, sessionService } = wire(false);
    await controller.startSession(request(), headers);
    expect(pipelineService.getAll).toHaveBeenCalledTimes(1);
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'azure-pipeline' }));
  });
});

describe('SttCompatController.switchSession — agent path (TASK-861)', () => {
  it('trusts the runtime for the fallback direction instead of the TenantSttConfig pre-check', async () => {
    const { controller, sessionService, sttConfig } = wire();
    await expect(controller.switchSession({ session_id: 'session_123456789', target: 'default' } as never, headers)).resolves.toEqual({ switched: true, active: 'default' });
    expect(sttConfig.getEffective).not.toHaveBeenCalled();
    expect(sessionService.switchProvider).toHaveBeenCalledWith('session_123456789', 'fallback', 'tenant-1');
  });
});

describe('SttCompatController.startSession — pipelineId deprecation headers (TASK-861 follow-up)', () => {
  it('an explicit pipelineId (deprecated path) answers with the same three headers as stream/session + transcribe; the agent path sets none', async () => {
    const { controller, asrResolver, sessionService } = wire();

    const deprecated = { setHeader: vi.fn() };
    await controller.startSession({ ...request(), pipelineId: 'pipe-1' } as StartSessionRequest, headers, deprecated as never);
    expect(asrResolver.resolve).not.toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pipe-1' }));
    expect(deprecated.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(deprecated.setHeader).toHaveBeenCalledWith(
      'X-Deprecation-Notice',
      'TASK-861 - pipelineId is removed in R4; send agentSlug (or nothing, for the assigned ASR agent)',
    );
    expect(deprecated.setHeader).toHaveBeenCalledWith('Link', '</api/v1/agents?task=SPEECH_TO_TEXT>; rel="successor-version"');
    // No `Sunset` until the removal tags are named (TASK-861 §7.5 Q1 / OD-2).
    expect(deprecated.setHeader).toHaveBeenCalledTimes(3);

    const agentPath = { setHeader: vi.fn() };
    await controller.startSession(request(), headers, agentPath as never);
    expect(asrResolver.resolve).toHaveBeenCalledTimes(1);
    expect(agentPath.setHeader).not.toHaveBeenCalled();
  });

  it('the JSON body path is unchanged with no response object (positional test construction, passthrough)', async () => {
    const { controller } = wire();
    const out = await controller.startSession({ ...request(), pipelineId: 'pipe-1' } as StartSessionRequest, headers);
    expect(out).toMatchObject({ message: 'Session started', session_id: 'session_123456789', status: 'active', provider: 'azure' });
  });
});
