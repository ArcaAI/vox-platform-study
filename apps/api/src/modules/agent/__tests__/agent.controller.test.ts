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
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object' },
    tools: [],
    protocols: ['http', 'http-sse'],
  },
  models: [],
  // TASK-890 §3.14 — `AgentResolverService` always answers this (absence normalises to ON).
  guardrail: { enabled: true },
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
    invokeText: vi.fn(async (_r: unknown, _t: string, _i: unknown, mode: string) =>
      mode === 'stream' ? { stream: new PassThrough() } : { text: 'hello', provider: 'lm-studio', model: 'lms-gemma-4-e2b-it-qat', usage: null },
    ),
    buildSpeechRequest: vi.fn(),
    resolveAsrPipelineId: vi.fn(async () => 'pipe-1'),
    // TASK-890 §3.14 — the ledger's screening disposition for this call.
    guardrailDisposition: vi.fn(async (decision: { enabled: boolean }): Promise<'screened' | 'opted_out' | 'platform_off'> =>
      decision.enabled ? 'screened' : 'opted_out',
    ),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) };
  const jobService = { createBatchJob: vi.fn(async (_input: unknown) => ({ id: 'job-1', status: 'PENDING' })), failJob: vi.fn() };
  const realtimeService = { dispatchDramatiqJob: vi.fn(async () => undefined) };
  const mediaService = { fetchById: vi.fn(async () => ({ id: 'media-1', uri: 's3://bucket/audio.wav' })) };
  // TASK-861 — the ASR resolution behind `transcriptions`.
  const asrResolver = {
    resolve: vi.fn(async () => ({
      spec: {
        schemaVersion: 1,
        runtimeKey: 'agent-v-1',
        agent: { slug: 'platform-transcription', versionId: 'agent-v-1' },
        models: { asr: { slug: 'whisper' } },
        fallback: { kind: 'none', spec: null },
      },
    })),
  };
  // TASK-890 L11 — metering parity: the invocation routes now precheck the
  // LLM-token allowance and record what they spent, as `speech()` always did.
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const usageLedger = { recordUsage: vi.fn(async (_batch: unknown) => ({ written: 1 })) };
  const deps = {
    agentService,
    resolver,
    invocation,
    cls,
    jobService,
    realtimeService,
    mediaService,
    asrResolver,
    entitlementsService,
    usageLedger,
    httpService: {} as unknown,
    ...overrides,
  };
  const controller = new AgentController(
    deps.agentService as never,
    deps.resolver as never,
    deps.invocation as never,
    deps.cls as never,
    deps.httpService as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined, // secretsService
    undefined, // ttsResolver
    deps.entitlementsService as never,
    deps.usageLedger as never,
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

  // TASK-890 §3.3/§3.4 — `context` is checked against the agent's FROZEN context schema, not
  // against `inputSchema`. Every default `inputSchema` is `additionalProperties: false` and
  // declares only `{ text, variables }`, so validating the whole body against it made an agent
  // that PINS a context schema impossible to invoke with a context — the enforcement path was
  // unreachable through the route meant to reach it.
  it('withholds `context` from the inputSchema check, and still forwards it to the service', async () => {
    const { controller, invocation } = make();
    await controller.invoke('clinic-summarizer', { text: 'hi', context: { visit: { clinic: 'Ward 7' } } }, fakeRes() as never, undefined);

    expect(invocation.inputProblems).toHaveBeenCalledWith(expect.anything(), { text: 'hi' });
    expect(invocation.invokeText).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { text: 'hi', context: { visit: { clinic: 'Ward 7' } } },
      'blocking',
    );
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
      expect.objectContaining({
        agentVersionId: 'agent-v-1',
        resolvedSpec: expect.objectContaining({ runtimeKey: 'agent-v-1' }),
        mediaId: 'media-1',
        consultationId: undefined,
      }),
    );
    expect(jobService.createBatchJob.mock.calls[0][0]).not.toHaveProperty('pipelineId');
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        pipelineId: 'agent-v-1',
        resolvedSpec: expect.objectContaining({ runtimeKey: 'agent-v-1' }),
        audioUri: 's3://bucket/audio.wav',
        language: 'ml-en',
      }),
    );
    expect(out).toMatchObject({
      id: 'job-1',
      agentSlug: 'platform-transcription',
      agentVersionId: 'agent-v-1',
      pipelineId: 'agent-v-1',
      sseUrl: '/api/v1/audio/transcription-jobs/job-1/stream',
    });
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

/**
 * TASK-890 L11 (BLOCKER #7, OD-E) — `POST /agents/:slug/invocations` checked no
 * quota and recorded no usage while `speech()` on the SAME controller did both.
 * A tenant could run the platform's most expensive route without limit and
 * without a line on its own bill.
 */
describe('AgentController — metering parity on invocations', () => {
  function usageResult() {
    return { text: 'hello', provider: 'lm-studio', model: 'lms-gemma-4-e2b-it-qat', usage: { promptTokens: 120, completionTokens: 40 } };
  }

  it('prechecks the LLM-token allowance BEFORE the (expensive) TEXT call', async () => {
    const { controller, entitlementsService, invocation } = make();
    invocation.invokeText.mockResolvedValue(usageResult());
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    expect(entitlementsService.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyLlmTokens');
    expect(entitlementsService.assertMeterQuota.mock.invocationCallOrder[0]).toBeLessThan(invocation.invokeText.mock.invocationCallOrder[0]);
  });

  it('short-circuits on an exhausted allowance — no TEXT call, no ledger row', async () => {
    const { controller, entitlementsService, invocation, usageLedger } = make();
    entitlementsService.assertMeterQuota.mockRejectedValue(new Error('quota exceeded'));
    await expect(controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined)).rejects.toThrow();
    expect(invocation.invokeText).not.toHaveBeenCalled();
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('blocking: records ONE `generate` batch carrying trigger AGENT_INVOCATION', async () => {
    const { controller, usageLedger, invocation } = make();
    invocation.invokeText.mockResolvedValue(usageResult());
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    const batch = usageLedger.recordUsage.mock.calls[0][0] as {
      common: { operation: string; provider: string; attributesJson?: Record<string, unknown> };
      units: { quantity: number }[];
    };
    expect(batch.common.operation).toBe('generate');
    expect(batch.common.provider).toBe('lm-studio');
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'AGENT_INVOCATION' });
    expect(batch.units.length).toBeGreaterThan(0);
  });

  it('blocking: records nothing when TEXT reported no usage — never a row saying "nothing happened"', async () => {
    const { controller, usageLedger } = make();
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('blocking: a ledger failure never breaks a delivered generation', async () => {
    const { controller, usageLedger, invocation } = make();
    invocation.invokeText.mockResolvedValue(usageResult());
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox down'));
    const res = fakeRes();
    await expect(controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, undefined)).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.statusCode).toBe(200);
  });

  it('stream: tees the terminal usage frame and records ONE `generate.stream` batch', async () => {
    const { controller, usageLedger, invocation } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });
    const res = fakeRes();
    await controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, 'stream');
    stream.write('data: {"data":{"delta":"Pati"}}\n\n');
    stream.write(
      `data: ${JSON.stringify({
        data: {
          usage: {
            task_id: 'task-9',
            provider: 'openai_compat',
            model: 'lms-gemma-4-e2b-it-qat',
            endpoint_kind: 'openai.chat',
            interrupted: false,
            byok: false,
            prompt_tokens: 10,
            completion_tokens: 5,
          },
        },
      })}\n\n`,
    );
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { operation: string; attributesJson?: Record<string, unknown> } };
    expect(batch.common.operation).toBe('generate.stream');
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'AGENT_INVOCATION' });
  });

  it('stream: the frames the caller receives are untouched — the tee reads a side copy', async () => {
    const { controller, invocation } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });
    const res = fakeRes();
    await controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, 'stream');
    stream.write('data: {"data":{"delta":"Pati"}}\n\n');
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.chunks.join('')).toBe('data: {"data":{"delta":"Pati"}}\n\n');
  });
});

describe('AgentController — speech carries the same activity dimension', () => {
  it('stamps trigger AGENT_INVOCATION on the tts.synthesize row', async () => {
    const stream = new PassThrough();
    const httpService = {
      axiosRef: { post: vi.fn(async () => ({ headers: { 'content-type': 'audio/wav', 'x-tts-provider': 'kokoro' }, data: stream })) },
    };
    const { controller, usageLedger } = make({
      httpService,
      invocation: {
        inputProblems: vi.fn(() => []),
        invokeText: vi.fn(),
        buildSpeechRequest: vi.fn(() => ({ input: 'hello there', voice: 'af_heart' })),
        resolveAsrPipelineId: vi.fn(),
      },
      resolver: { resolve: vi.fn(async () => ({ ...RESOLVED, task: 'TEXT_TO_SPEECH' })) },
    });
    const res = fakeRes();
    await controller.speech('platform-tts', { text: 'hello there' }, res as never);
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { operation: string; attributesJson?: Record<string, unknown> } };
    expect(batch.common.operation).toBe('tts.synthesize');
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'AGENT_INVOCATION', interrupted: false });
  });
});

/**
 * TASK-890 §3.14 (OD-R) — the RECORD half of the guardrail opt-out.
 *
 * A tenant may switch platform screening off per agent / workflow / node. What makes that a
 * decision on the record rather than a silent omission is this attribute: every generation row
 * says whether the guard ran (`screened`), whether this tenant turned it off (`opted_out`), or
 * whether the platform kill switch made every opt-out moot (`platform_off`).
 */
describe('AgentController — the guardrail disposition on the ledger row (§3.14)', () => {
  const usageResult = () => ({
    text: 'hello',
    provider: 'lm-studio',
    model: 'lms-gemma-4-e2b-it-qat',
    usage: { promptTokens: 120, completionTokens: 40 },
  });

  it('blocking: stamps `opted_out` when the resolved agent opted out', async () => {
    const { controller, usageLedger, invocation, resolver } = make();
    resolver.resolve.mockResolvedValue({ ...RESOLVED, guardrail: { enabled: false } });
    invocation.invokeText.mockResolvedValue(usageResult());
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { attributesJson?: Record<string, unknown> } };
    expect(batch.common.attributesJson).toMatchObject({ guardrail: 'opted_out', trigger: 'AGENT_INVOCATION' });
  });

  it('blocking: stamps `screened` for an agent that did not opt out', async () => {
    const { controller, usageLedger, invocation } = make();
    invocation.invokeText.mockResolvedValue(usageResult());
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { attributesJson?: Record<string, unknown> } };
    expect(batch.common.attributesJson).toMatchObject({ guardrail: 'screened' });
  });

  it('stream: the same disposition rides the `generate.stream` row', async () => {
    const { controller, usageLedger, invocation, resolver } = make();
    resolver.resolve.mockResolvedValue({ ...RESOLVED, guardrail: { enabled: false } });
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(
      `data: ${JSON.stringify({
        data: {
          usage: {
            task_id: 'task-9',
            provider: 'openai_compat',
            model: 'lms-gemma-4-e2b-it-qat',
            endpoint_kind: 'openai.chat',
            interrupted: false,
            byok: false,
            prompt_tokens: 10,
            completion_tokens: 5,
          },
        },
      })}\n\n`,
    );
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { operation: string; attributesJson?: Record<string, unknown> } };
    expect(batch.common.operation).toBe('generate.stream');
    expect(batch.common.attributesJson).toMatchObject({ guardrail: 'opted_out' });
  });

  it('the platform switch beats the tenant`s opt-out — a platform-off gate is not a tenant decision', async () => {
    const { controller, usageLedger, invocation, resolver } = make();
    resolver.resolve.mockResolvedValue({ ...RESOLVED, guardrail: { enabled: false } });
    invocation.guardrailDisposition.mockResolvedValue('platform_off');
    invocation.invokeText.mockResolvedValue(usageResult());
    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const batch = usageLedger.recordUsage.mock.calls[0][0] as { common: { attributesJson?: Record<string, unknown> } };
    expect(batch.common.attributesJson).toMatchObject({ guardrail: 'platform_off' });
  });

  it('the TTS row carries NO guardrail dimension — a speech call passes no guardrail gate at all', async () => {
    // `null`/absent is the allow-list's own spelling of "this dimension does not apply"; a
    // fabricated `screened` here would put a screening claim on a call nothing screened.
    const { controller, usageLedger } = make({
      resolver: { resolve: vi.fn(async () => ({ ...RESOLVED, task: 'TEXT_TO_SPEECH' })) },
    });
    await controller.speech('tts-agent', { text: 'hello' }, fakeRes() as never).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    for (const call of usageLedger.recordUsage.mock.calls) {
      const batch = call[0] as { common: { attributesJson?: Record<string, unknown> } };
      expect(batch.common.attributesJson?.guardrail).toBeUndefined();
    }
  });
});
