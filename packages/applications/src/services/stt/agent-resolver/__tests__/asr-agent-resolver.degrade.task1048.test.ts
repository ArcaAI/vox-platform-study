/**
 * TASK-1048 — `AsrAgentResolverService` carries optional-stage degradations OUT as `warnings`
 * (never a 409), logs each one at warn level, and resolves the OD-2 platform default
 * speaker-embedding model (tenant → SYSTEM setting, then a SPEAKER_EMBEDDING row visible to the
 * tenant) only when a chain actually needs it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null } }>;
const platformAgent = fixture.platformDefault.input.agent;
const cloudAgent = fixture.cloudWithAgentFallback.input.agent;

const TENANT = '50000000-0000-0000-0000-000000000001';

const withFrontEnd = (audioFrontEnd: Record<string, unknown>, agent: ResolvedAgent = platformAgent): ResolvedAgent => ({
  ...agent,
  compiledConfig: { ...agent.compiledConfig, parameters: { ...(agent.compiledConfig.parameters as object), audioFrontEnd } },
});
/** The tester's `sarvam-diarization` shape: diarization on, no embeddingModelSlug, no embedding row. */
const sarvamLike = (): ResolvedAgent => ({ ...withFrontEnd({ diarization: { enabled: true } }), models: platformAgent.models.filter((m) => m.role !== 'embedding') });

const PLATFORM_EMBEDDING: ResolvedAgentModel = {
  role: 'embedding',
  slug: 'wespeaker-voxceleb-resnet34',
  sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
  sourceRevision: null,
  localPath: 'models/system/wespeaker-voxceleb-resnet34',
  checksum: null,
  format: 'PYTORCH',
  computeType: null,
  provider: null,
  tenantId: '00000000-0000-0000-0000-000000000000',
};

const agents = { resolve: vi.fn(), resolveModelBySlug: vi.fn() };
const settings = { resolveEffective: vi.fn() };
const governingWorkflows = { readConsultation: vi.fn(), readGoverningWorkflow: vi.fn(), findAsrAgent: vi.fn(), readPublishedWorkflow: vi.fn() };

const make = (withSettings = true) =>
  new AsrAgentResolverService(agents as never, undefined, undefined, governingWorkflows as never, withSettings ? (settings as never) : undefined);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  settings.resolveEffective.mockResolvedValue({ key: STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, tier: 'global-kv', value: 'wespeaker-voxceleb-resnet34', sourceScope: 'system' });
  agents.resolveModelBySlug.mockResolvedValue(PLATFORM_EMBEDDING);
});

describe('AsrAgentResolverService — optional stages degrade (TASK-1048 OD-1)', () => {
  it('the tester’s agent (diarization on, no embedding model, no platform default) resolves — 201, not 409 — with a DIARIZATION_MODEL_MISSING warning', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    settings.resolveEffective.mockRejectedValueOnce(new ArgumentInvalidException('unresolved, fail-closed'));

    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });

    expect(session.spec.audioFrontEnd.diarization.enabled).toBe(false);
    expect(session.warnings).toEqual([
      expect.objectContaining({ code: 'DIARIZATION_MODEL_MISSING', stage: 'diarization', severity: 'WARNING', agentSlug: platformAgent.slug }),
    ]);
    expect(agents.resolveModelBySlug).not.toHaveBeenCalled();
  });

  it('logs every warning at WARN with its code and agent identity — and no message body beyond the fixed sentence', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    settings.resolveEffective.mockRejectedValueOnce(new ArgumentInvalidException('unresolved'));
    await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DIARIZATION_MODEL_MISSING', stage: 'diarization', tenantId: TENANT, agentSlug: platformAgent.slug }),
    );
  });

  it('a clean agent carries no warnings key at all', async () => {
    agents.resolve.mockResolvedValueOnce(platformAgent);
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(session).not.toHaveProperty('warnings');
  });

  it('a retired backend no longer 409s — DIARIZATION_BACKEND_UNSUPPORTED', async () => {
    agents.resolve.mockResolvedValueOnce(withFrontEnd({ diarization: { enabled: true, backend: 'sortformer' } }));
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(session.warnings?.map((w) => w.code)).toEqual(['DIARIZATION_BACKEND_UNSUPPORTED']);
  });

  it('CORE refusals are unchanged: no primary model is still a 409', async () => {
    agents.resolve.mockResolvedValueOnce({ ...platformAgent, models: platformAgent.models.filter((m) => m.role !== 'primary') });
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AsrAgentResolverService — OD-2 platform default speaker-embedding model', () => {
  it('reads the setting for the session TENANT and resolves the slug as a SPEAKER_EMBEDDING model, then diarizes with it', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());

    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });

    expect(settings.resolveEffective).toHaveBeenCalledWith(STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, { tenantId: TENANT });
    expect(agents.resolveModelBySlug).toHaveBeenCalledWith('wespeaker-voxceleb-resnet34', TENANT, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' });
    expect(session.spec.audioFrontEnd.diarization.enabled).toBe(true);
    expect(session.spec.models.embedding?.slug).toBe('wespeaker-voxceleb-resnet34');
    expect(session).not.toHaveProperty('warnings');
  });

  it('a configured slug the tenant cannot see (or of another task) degrades with DIARIZATION_MODEL_MISSING', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    agents.resolveModelBySlug.mockResolvedValueOnce(null);
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });
    expect(session.spec.audioFrontEnd.diarization.enabled).toBe(false);
    expect(session.warnings?.map((w) => w.code)).toEqual(['DIARIZATION_MODEL_MISSING']);
  });

  it('never reads the setting when no chain needs it (agent-bound embedding model, or diarization off)', async () => {
    agents.resolve.mockResolvedValueOnce(platformAgent);
    await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(settings.resolveEffective).not.toHaveBeenCalled();
    expect(agents.resolveModelBySlug).not.toHaveBeenCalled();
  });

  it('a settings BACKEND error propagates — it is never disguised as "no platform default"', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    settings.resolveEffective.mockRejectedValueOnce(new Error('cache exploded'));
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' })).rejects.toThrow('cache exploded');
  });

  it('an unwired settings service degrades rather than failing the session', async () => {
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    const session = await make(false).resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });
    expect(session.warnings?.map((w) => w.code)).toEqual(['DIARIZATION_MODEL_MISSING']);
  });
});

describe('AsrAgentResolverService — fallbacks (TASK-1048)', () => {
  const withFallbackSlug = (slug: string): ResolvedAgent => ({
    ...cloudAgent,
    compiledConfig: {
      ...cloudAgent.compiledConfig,
      parameters: { ...(cloudAgent.compiledConfig.parameters as object), fallback: { agentSlug: slug } },
    },
  });

  it('a fallback agent that does not resolve is skipped AND reported (FALLBACK_UNRUNNABLE), the primary session still opens', async () => {
    agents.resolve.mockResolvedValueOnce(withFallbackSlug('gone-agent')).mockRejectedValueOnce(new NotFoundException('Agent not found'));
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(session.spec.fallback.kind).toBe('none');
    expect(session.warnings).toEqual([expect.objectContaining({ code: 'FALLBACK_UNRUNNABLE', stage: 'fallback', agentSlug: 'gone-agent' })]);
  });

  it('a fallback agent that resolved no ASR model is skipped BEFORE credentials are resolved for it', async () => {
    const broken: ResolvedAgent = { ...platformAgent, slug: 'broken-fallback', models: [] };
    agents.resolve.mockResolvedValueOnce(withFallbackSlug('broken-fallback')).mockResolvedValueOnce(broken);
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });
    expect(session.spec.fallback.kind).toBe('none');
    expect(session.warnings?.map((w) => [w.code, w.agentSlug])).toEqual([['FALLBACK_UNRUNNABLE', 'broken-fallback']]);
  });
});

describe('AsrAgentResolverService — a governing workflow no longer refuses for an optional stage', () => {
  it('a consultation whose workflow names a diarizing agent with no embedding model opens with a warning, not WORKFLOW_ASR_AGENT_UNAVAILABLE', async () => {
    governingWorkflows.readConsultation.mockResolvedValueOnce({ id: 'c-1', departmentId: null, metadata: {}, spokenLanguageMode: null });
    governingWorkflows.readGoverningWorkflow.mockResolvedValueOnce({ slug: 'wf' });
    governingWorkflows.findAsrAgent.mockResolvedValueOnce({ workflowDefinitionSlug: 'wf', nodeId: 'asr', agentSlug: 'sarvam-diarization' });
    agents.resolve.mockResolvedValueOnce(sarvamLike());
    settings.resolveEffective.mockRejectedValueOnce(new ArgumentInvalidException('unresolved'));

    const session = await make().resolve({ tenantId: TENANT, consultationId: 'c-1' });

    expect(session.spec.agent.source).toBe('workflow');
    expect(session.workflowDefinitionSlug).toBe('wf');
    expect(session.warnings?.map((w) => w.code)).toEqual(['DIARIZATION_MODEL_MISSING']);
  });
});
