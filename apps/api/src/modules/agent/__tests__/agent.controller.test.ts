/**
 * TASK-863 — AgentController (business plane): route metadata (API-key scopes + a JWT
 * authorization decorator on every route), TIER 3 input validation, blocking vs stream
 * delivery, and the batch-transcription handshake.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';
const RESOLVED = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'clinic-summarizer',
  versionNumber: 2,
  task: 'TEXT_GENERATION',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: { task: 'TEXT_GENERATION', service: 'llm', model: { id: 'm', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' }, fallbacks: [], instruction: null, resolvedPrompt: null, parameters: {}, inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, outputSchema: { type: 'object' }, tools: [], protocols: ['http', 'http-sse'] },
  models: [],
};

function fakeRes() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    headers,
    chunks,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn((k: string, v: string) => void (headers[k] = v)),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: Buffer | string) => void chunks.push(String(chunk))),
    end: vi.fn(),
    status: vi.fn(function (this: unknown, code: number) {
      (res as { statusCode: number }).statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => void ((res as { body: unknown }).body = body)),
    on: vi.fn(),
  };
  return res;
}

function make(overrides: Record<string, unknown> = {}) {
  const agentService = { listPublished: vi.fn(async () => [{ slug: 'x' }]), getPublishedBySlug: vi.fn(async (slug: string) => ({ slug })) };
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => []),
    invokeText: vi.fn(async (_r: unknown, _t: string, _i: unknown, mode: string) => (mode === 'stream' ? { stream: new PassThrough() } : { text: 'hello', provider: 'lm-studio', model: 'lms-gemma-4-e2b-it-qat', usage: null })),
    buildSpeechRequest: vi.fn(),
    resolveAsrPipelineId: vi.fn(async () => 'pipe-1'),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) };
  const jobService = { createBatchJob: vi.fn(async () => ({ id: 'job-1', status: 'PENDING' })), failJob: vi.fn() };
  const realtimeService = { dispatchDramatiqJob: vi.fn(async () => undefined) };
  const mediaService = { fetchById: vi.fn(async () => ({ id: 'media-1', uri: 's3://bucket/audio.wav' })) };
  // TASK-861 — the ASR resolution behind `transcriptions`.
  const asrResolver = {
    resolve: vi.fn(async () => ({
      spec: { schemaVersion: 1, runtimeKey: 'agent-v-1', agent: { slug: 'platform-transcription', versionId: 'agent-v-1' }, models: { asr: { slug: 'whisper' } }, fallback: { kind: 'none', spec: null } },
    })),
  };
  const deps = { agentService, resolver, invocation, cls, jobService, realtimeService, mediaService, asrResolver, ...overrides };
  const controller = new AgentController(
    deps.agentService as never,
    deps.resolver as never,
    deps.invocation as never,
    deps.cls as never,
    {} as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    deps.jobService as never,
    deps.realtimeService as never,
    deps.mediaService as never,
    deps.asrResolver as never,
  );
  return { controller, ...deps };
}

describe('AgentController — metadata', () => {
  it('mounts at agents; every route carries an authorization decorator (JWT path) AND an API-key scope', () => {
    expect(Reflect.getMetadata('path', AgentController)).toBe('agents');
    const proto = AgentController.prototype;
    for (const handler of [proto.list, proto.get, proto.invoke, proto.speech, proto.transcribe]) {
      const permissions = new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, AgentController]);
      expect(Array.isArray(permissions)).toBe(true);
      const keys = Reflect.getMetadataKeys(handler).map(String);
      expect(keys.some((key) => /scope/i.test(key) && !/svc|service/i.test(key))).toBe(true);
    }
    expect(Reflect.getMetadata('path', proto.invoke)).toBe(':slug/invocations');
    expect(Reflect.getMetadata('path', proto.speech)).toBe(':slug/speech');
    expect(Reflect.getMetadata('path', proto.transcribe)).toBe(':slug/transcriptions');
    expect(Reflect.getMetadata('__httpCode__', proto.transcribe)).toBe(201);
  });
});

describe('AgentController — invocations', () => {
  it('blocking: resolves with the TEXT_GENERATION task pin, validates the body, answers JSON', async () => {
    const { controller, resolver, invocation } = make();
    const res = fakeRes();
    await controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, undefined);
    expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: 'TEXT_GENERATION', agentSlug: 'clinic-summarizer' });
    expect(invocation.invokeText).toHaveBeenCalledWith(RESOLVED, TENANT, { text: 'hi' }, 'blocking');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ agentSlug: 'clinic-summarizer', output: { text: 'hello' } });
  });

  it('rejects a body that violates the agent inputSchema (TIER 3) before calling the model', async () => {
    const { controller, invocation } = make();
    invocation.inputProblems.mockReturnValue(['/text: required property is missing']);
    await expect(controller.invoke('clinic-summarizer', {}, fakeRes() as never, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(invocation.invokeText).not.toHaveBeenCalled();
  });

  it('stream: relays the TEXT SSE frames with the streaming headers', async () => {
    const { controller, invocation } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });
    const res = fakeRes();
    await controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, 'stream');
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['X-Agent-Slug']).toBe('clinic-summarizer');
    stream.write('event: meta\ndata: {"generation_id":"g1"}\n\n');
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.chunks.join('')).toContain('generation_id');
    expect(res.end).toHaveBeenCalled();
  });
});

describe('AgentController — transcriptions (TASK-861: agent-keyed, no pipeline row)', () => {
  it('resolves the agent to a ResolvedAsrSpec, creates an agent-keyed job and dispatches the spec with the media uri', async () => {
    const { controller, jobService, realtimeService, asrResolver, invocation } = make();
    const out = await controller.transcribe('platform-transcription', { mediaId: 'media-1', language: 'ml-en' });
    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: TENANT, agentSlug: 'platform-transcription', departmentId: null });
    expect(invocation.resolveAsrPipelineId).not.toHaveBeenCalled();
    expect(jobService.createBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: 'agent-v-1', resolvedSpec: expect.objectContaining({ runtimeKey: 'agent-v-1' }), mediaId: 'media-1', consultationId: undefined }),
    );
    expect(jobService.createBatchJob.mock.calls[0][0]).not.toHaveProperty('pipelineId');
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', pipelineId: 'agent-v-1', resolvedSpec: expect.objectContaining({ runtimeKey: 'agent-v-1' }), audioUri: 's3://bucket/audio.wav', language: 'ml-en' }),
    );
    expect(out).toMatchObject({ id: 'job-1', agentSlug: 'platform-transcription', agentVersionId: 'agent-v-1', pipelineId: 'agent-v-1', sseUrl: '/api/v1/audio/transcription-jobs/job-1/stream' });
  });

  it('fails closed (409) when the agent cannot become a runnable spec — the resolver’s verdict propagates untouched', async () => {
    const { controller, asrResolver, jobService } = make();
    asrResolver.resolve.mockRejectedValue(new ConflictException({ code: 'ASR_AGENT_UNRUNNABLE' }));
    await expect(controller.transcribe('x', { mediaId: 'media-1' })).rejects.toBeInstanceOf(ConflictException);
    expect(jobService.createBatchJob).not.toHaveBeenCalled();
  });

  it('marks the job FAILED when dispatch fails', async () => {
    const { controller, realtimeService, jobService } = make();
    realtimeService.dispatchDramatiqJob.mockRejectedValue(new Error('redis down'));
    await expect(controller.transcribe('x', { mediaId: 'media-1' })).rejects.toThrow();
    expect(jobService.failJob).toHaveBeenCalledWith('job-1', 'redis down', 'SETUP_ERROR');
  });
});
