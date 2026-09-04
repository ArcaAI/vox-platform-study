/**
 * TASK-861 — TranscriptionJobController on the ASR Agent path.
 *
 * `POST stream/session` and `POST transcribe` resolve a `ResolvedAsrSpec` through
 * `AsrAgentResolverService` (explicit `agentSlug`, else the assignment cascade) and hand
 * it to the STT runtime / the batch job; the deprecated `pipelineId` path stays for the
 * window and answers with `Deprecation` headers. `GET fallback` and the fallback switch
 * guard read the resolver, not `TenantSttConfig`.
 */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'platform-default' },
  models: { asr: { role: 'asr', slug: 'whisper', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', format: 'WHISPER_CPP', sourceUri: 'x', sourceRevision: null, localPath: null, checksum: null, computeType: null, provider: null, tenantId: '0'.repeat(36) } },
  audioFrontEnd: {}, decoding: {}, postProcessing: {}, streaming: {}, instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'model', autoSwitch: false, switchAfterConsecutiveFailures: 3, spec: { runtimeKey: 'agent-v-1:fallback:fw', agent: { slug: 'platform-transcription', versionId: 'agent-v-1' }, models: { asr: { slug: 'fw' } } } },
};

const mocks = () => ({
  jobService: {
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    create: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    failJob: vi.fn(),
    getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0 }),
  },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1, pipelineId: 'agent-v-1', activeEngine: 'primary' }),
    switchToFallback: vi.fn().mockResolvedValue(undefined),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  pipelineService: { getById: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
  binding: { bind: vi.fn(), bindSessionMeta: vi.fn(), clear: vi.fn() },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  sttConfig: { getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: null }), resolveProviderOverrides: vi.fn().mockResolvedValue({}) },
  asrResolver: { resolve: vi.fn().mockResolvedValue({ spec, providerOverrides: { 'azure-speech': { api_key: 'k', funding: 'tenant' } }, fundingTier: 'tenant' }) },
});

function build(withResolver = true) {
  const m = mocks();
  const controller = new TranscriptionJobController(
    m.jobService as never, m.realtimeService as never, m.sessionService as never, m.cls as never, m.blobStorage as never,
    m.tenantBucketService as never, m.pipelineService as never, m.streamTicketService as never, m.binding as never,
    m.entitlements as never, m.sttConfig as never, undefined, withResolver ? (m.asrResolver as never) : undefined,
  );
  return { controller, m };
}

const res = () => ({ setHeader: vi.fn() });

beforeEach(() => vi.clearAllMocks());

describe('createStreamSession — agent path', () => {
  it('agentSlug → the resolver (explicit slug) and the spec goes to STT keyed on runtimeKey; no pipeline row is consulted', async () => {
    const { controller, m } = build();
    const out = await controller.createStreamSession({ agentSlug: 'platform-transcription', languageMode: 'ml-en' } as never, res() as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: 'platform-transcription', departmentId: null });
    expect(m.pipelineService.getById).not.toHaveBeenCalled();
    expect(m.sttConfig.getEffective).not.toHaveBeenCalled();
    const payload = m.sessionService.createSession.mock.calls[0][0];
    expect(payload).toMatchObject({
      pipelineId: 'agent-v-1',
      resolvedSpec: spec,
      fallbackPipelineId: 'agent-v-1:fallback:fw',
      autoSwitchEnabled: false,
      consecutiveFailureThreshold: 3,
      providerOverrides: { 'azure-speech': { api_key: 'k', funding: 'tenant' } },
      languageMode: 'ml-en',
    });
    expect(out).toMatchObject({ sessionId: 'sess-1', agentSlug: 'platform-transcription', agentVersionId: 'agent-v-1', pipelineId: 'agent-v-1' });
  });

  it('no agentSlug and no pipelineId → the assignment cascade decides', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({} as never, res() as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null });
  });

  it('startOn=fallback with a spec that declares no fallback → 409 (fail closed), nothing forwarded', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValueOnce({ spec: { ...spec, fallback: { kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null } } });
    await expect(controller.createStreamSession({ startOn: 'fallback' } as never, res() as never)).rejects.toBeInstanceOf(ConflictException);
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('the deprecated pipelineId path still works for the window and answers with Deprecation headers', async () => {
    const { controller, m } = build();
    m.pipelineService.getById.mockResolvedValue({ id: 'pipe-1', tenantId: 'tenant-1', name: 'p' });
    const r = res();
    await controller.createStreamSession({ pipelineId: 'pipe-1' } as never, r as never);
    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(m.sessionService.createSession.mock.calls[0][0]).toMatchObject({ pipelineId: 'pipe-1' });
    expect(r.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(r.setHeader).toHaveBeenCalledWith('X-Deprecation-Notice', expect.stringContaining('TASK-861'));
  });

  it('agent path without a resolver wired → 503 (never a silent pipeline guess)', async () => {
    const { controller } = build(false);
    await expect(controller.createStreamSession({ agentSlug: 'x' } as never, res() as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('create (JSON) — agent path', () => {
  it('no ids → the assignment cascade resolves the agent and the job is keyed to agentVersionId + resolvedSpec', async () => {
    const { controller, m } = build();
    m.jobService.create = vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' });
    await controller.create({ mediaId: 'media-1' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null });
    expect(m.jobService.create).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'media-1', agentVersionId: 'agent-v-1', resolvedSpec: spec }));
    expect(m.jobService.create.mock.calls[0][0]).not.toHaveProperty('agentSlug');
    expect(m.jobService.create.mock.calls[0][0]).not.toHaveProperty('pipelineId');
  });

  it('an explicit agentSlug goes to the resolver and never reaches the service as a field', async () => {
    const { controller, m } = build();
    m.jobService.create = vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' });
    await controller.create({ mediaId: 'media-1', agentSlug: 'platform-transcription' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: 'platform-transcription', departmentId: null });
    expect(m.jobService.create.mock.calls[0][0]).not.toHaveProperty('agentSlug');
  });

  it('the deprecated pipelineId path bypasses the resolver and answers with the Deprecation headers', async () => {
    const { controller, m } = build();
    m.jobService.create = vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' });
    const r = { setHeader: vi.fn() };
    await controller.create({ mediaId: 'media-1', pipelineId: 'pipe-1' } as never, r as never);
    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(m.jobService.create).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pipe-1' }));
    expect(r.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(r.setHeader).toHaveBeenCalledWith('X-Deprecation-Notice', expect.stringMatching(/^[\x20-\x7e]*$/));
  });

  it('no ids and no resolver wired → 503, never a silent pipeline guess', async () => {
    const { controller, m } = build(false);
    m.jobService.create = vi.fn();
    await expect(controller.create({ mediaId: 'media-1' } as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(m.jobService.create).not.toHaveBeenCalled();
  });
});

describe('transcribeFile — agent path', () => {
  const file = wavFixture(300);

  it('creates an agent-keyed job (agentVersionId + resolvedSpec, no pipelineId) and dispatches the spec as a kwarg', async () => {
    const { controller, m } = build();
    const out = await controller.transcribeFile(file, { agentSlug: 'platform-transcription', language: 'en' } as never, res() as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: 'platform-transcription', departmentId: null });
    expect(m.jobService.createBatchJob).toHaveBeenCalledWith(expect.objectContaining({ agentVersionId: 'agent-v-1', resolvedSpec: spec }));
    expect(m.jobService.createBatchJob.mock.calls[0][0]).not.toHaveProperty('pipelineId');
    expect(m.realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', pipelineId: 'agent-v-1', resolvedSpec: spec, language: 'en' }));
    expect(m.realtimeService.dispatchDramatiqJob.mock.calls[0][0]).not.toHaveProperty('fallbackPipelineId');
    expect(out).toMatchObject({ id: 'job-1', agentSlug: 'platform-transcription', agentVersionId: 'agent-v-1' });
  });

  it('never puts credentials in the job row or the queue message', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, {} as never, res() as never);
    expect(JSON.stringify(m.jobService.createBatchJob.mock.calls[0][0])).not.toContain('api_key');
    expect(JSON.stringify(m.realtimeService.dispatchDramatiqJob.mock.calls[0][0])).not.toContain('api_key');
  });
});

describe('fallback surfaces read the resolver, not TenantSttConfig', () => {
  it('GET fallback reports the resolved agent’s fallback (configured + runtime key + a display name)', async () => {
    const { controller, m } = build();
    const out = await controller.getFallbackProvider();
    expect(m.sttConfig.getEffective).not.toHaveBeenCalled();
    expect(out).toEqual({ configured: true, pipelineId: 'agent-v-1:fallback:fw', pipelineName: 'fw', agentSlug: 'platform-transcription' });
  });

  it('GET fallback degrades to not-configured on a resolve failure (labelling aid, never a 500)', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.getFallbackProvider()).resolves.toMatchObject({ configured: false });
  });

  it('switch-to-fallback trusts the runtime (STT 409s when the session has none) instead of the tenant config pre-check', async () => {
    const { controller, m } = build();
    await expect(controller.switchStreamSessionToFallback('sess-1')).resolves.toEqual({ switched: true });
    expect(m.sttConfig.getEffective).not.toHaveBeenCalled();
    expect(m.sessionService.switchToFallback).toHaveBeenCalledWith('sess-1', 'tenant-1');
  });
});
