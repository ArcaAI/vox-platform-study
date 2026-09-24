/**
 * TASK-1004 — `POST agents/:slug/transcriptions` takes a class-validator DTO
 * (`{ mediaId, consultationId?, language?, languageMode? }`) and applies the one selection:
 * request > the consultation's declared mode (one tenant-scoped read, requested only when the
 * request declares none) > the agent's own (left to STT). The NAMED agent always serves.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { AgentController } from '../agent.controller';
import { AgentTranscriptionRequest } from '../dto/agent-transcription.request';

const TENANT = '50000000-0000-0000-0000-000000000000';
const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1' },
  models: { asr: { slug: 'whisper' } },
  fallback: { kind: 'none', spec: null },
};

function make(consultationLanguageMode: string | null = 'ml-en') {
  const jobService = { createBatchJob: vi.fn(async () => ({ id: 'job-1', status: 'QUEUED' })), failJob: vi.fn() };
  const realtimeService = { dispatchDramatiqJob: vi.fn(async () => undefined) };
  const mediaService = { fetchById: vi.fn(async () => ({ id: 'media-1', uri: 's3://bucket/a.wav' })) };
  const asrResolver = { resolve: vi.fn(async () => ({ spec, ...(consultationLanguageMode !== undefined ? { consultationLanguageMode } : {}) })) };
  const controller = new AgentController(
    {} as never,
    {} as never,
    {} as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) } as never,
    {} as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    jobService as never,
    realtimeService as never,
    mediaService as never,
    asrResolver as never,
  );
  return { controller, jobService, realtimeService, asrResolver };
}

const dispatched = (r: { dispatchDramatiqJob: ReturnType<typeof vi.fn> }) => r.dispatchDramatiqJob.mock.calls[0]![0] as Record<string, unknown>;

describe('AgentTranscriptionRequest — a real DTO under the global pipe', () => {
  const opts = { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true };

  it('accepts { mediaId, consultationId, language, languageMode }', async () => {
    const dto = plainToInstance(AgentTranscriptionRequest, { mediaId: 'm-1', consultationId: 'c-1', language: 'ml-IN', languageMode: 'ml-en' });
    expect(await validate(dto, opts)).toEqual([]);
  });

  it('refuses a missing mediaId and an undeclared field', async () => {
    expect((await validate(plainToInstance(AgentTranscriptionRequest, { consultationId: 'c-1' }), opts)).map((e) => e.property)).toContain('mediaId');
    expect((await validate(plainToInstance(AgentTranscriptionRequest, { mediaId: 'm-1', engine: 'SARVAM' }), opts)).map((e) => e.property)).toContain(
      'engine',
    );
  });
});

describe('AgentController.transcribe — language', () => {
  it('consultationId only → one consultation read requested, its mode sent (source consultation), the named agent serves', async () => {
    const { controller, asrResolver, realtimeService } = make();
    await controller.transcribe('platform-transcription', { mediaId: 'media-1', consultationId: 'c-1' });
    expect(asrResolver.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      agentSlug: 'platform-transcription',
      departmentId: null,
      consultationId: 'c-1',
      inheritConsultationLanguage: true,
    });
    expect(dispatched(realtimeService)).toMatchObject({ languageMode: 'ml-en', languageModeSource: 'consultation', consultationId: 'c-1' });
  });

  it('an explicit languageMode wins and asks for no consultation read', async () => {
    const { controller, asrResolver, realtimeService } = make();
    await controller.transcribe('platform-transcription', { mediaId: 'media-1', consultationId: 'c-1', languageMode: 'EN' });
    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: TENANT, agentSlug: 'platform-transcription', departmentId: null });
    expect(dispatched(realtimeService)).toMatchObject({ languageMode: 'en', languageModeSource: 'request' });
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN before resolution or dispatch', async () => {
    const { controller, asrResolver, realtimeService } = make();
    await expect(controller.transcribe('platform-transcription', { mediaId: 'media-1', language: 'english please' })).rejects.toMatchObject({
      response: { code: 'LANGUAGE_MODE_UNKNOWN' },
    });
    expect(asrResolver.resolve).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });
});
