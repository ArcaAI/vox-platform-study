/**
 * TASK-957 F-4 — the tenant spend ceiling (D12) reaches the agent plane.
 *
 * `BillingService.assertSpendLimit` had exactly two callers, both on consultation summaries. A
 * tenant that set `monthlySpendLimitMicros` to bound its API-plane spend was therefore bounded
 * everywhere EXCEPT the two planes that can spend fastest: agent invocations (all three routes
 * here) and workflow runs. The meter quotas that DO run here are a different control — they cap
 * a QUANTITY of one unit, while the ceiling caps MONEY across every unit at once.
 *
 * Pinned per route, and in both directions: the check runs BEFORE the expensive call, and a
 * refusal reaches it before anything is spent or any job is created. The gate is opt-in and
 * cheap by construction — a tenant with no limit set returns immediately without computing a
 * draft — so it costs a metered route nothing until a limit exists.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { firstValueFrom, throwError } from 'rxjs';
import { HttpStatus, type CallHandler, type ExecutionContext, type HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendLimitExceededException } from '@arcaai/exceptions';
import { AgentController } from '../agent.controller';
import { ExceptionInterceptor } from '../../../interceptors/exception.interceptor';

const TENANT = '50000000-0000-0000-0000-000000000000';

const textAgent = {
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
    model: { id: 'm', slug: 'lms-gemma', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
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
  guardrail: { enabled: true },
};

const nerAgent = { ...textAgent, task: 'NAMED_ENTITY_RECOGNITION', slug: 'medical-ner' };
const ttsAgent = { ...textAgent, task: 'TEXT_TO_SPEECH', slug: 'clinic-voice' };

const overLimit = () =>
  new SpendLimitExceededException('Tenant has reached its monthly spend limit for 2026-09.', {
    tenantId: TENANT,
    period: '2026-09',
    spendLimitMicros: 1_000_000,
    overageSpendMicros: 1_000_000,
  });

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
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

function make(resolved: unknown = textAgent) {
  const resolver = { resolve: vi.fn(async () => resolved) };
  const invocation = {
    inputProblems: vi.fn(() => []),
    invokeText: vi.fn(async () => ({ text: 'hello', provider: 'lm-studio', model: 'lms-gemma', usage: null, promptFragments: null })),
    invokeNer: vi.fn(async () => ({ entities: [], model: 'medical-ner', charCount: 10, inferenceMs: null, device: null })),
    buildSpeechRequest: vi.fn(() => ({ input: 'hello there', voice: 'v1', model: 'kokoro' })),
    guardrailDisposition: vi.fn(async () => 'screened'),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const billing = { assertSpendLimit: vi.fn(async () => undefined) };
  const jobService = { createBatchJob: vi.fn(async () => ({ id: 'job-1', status: 'QUEUED' })), failJob: vi.fn() };
  const realtimeService = { dispatchDramatiqJob: vi.fn(async () => undefined) };
  const mediaService = { fetchById: vi.fn(async () => ({ uri: 's3://audio' })) };
  const asrResolver = {
    resolve: vi.fn(async () => ({ spec: { agent: { slug: 'asr', versionId: 'v1' }, runtimeKey: 'rk-1' } })),
  };
  const upstream = new PassThrough();
  const httpService = { axiosRef: { post: vi.fn(async () => ({ data: upstream, headers: { 'content-type': 'audio/wav' } })) } };
  const controller = new AgentController(
    { listPublished: vi.fn(), getPublishedBySlug: vi.fn() } as never,
    resolver as never,
    invocation as never,
    cls as never,
    httpService as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    entitlementsService as never,
    { recordUsage: vi.fn(async () => ({ written: 1 })) } as never,
    jobService as never,
    realtimeService as never,
    mediaService as never,
    asrResolver as never,
    billing as never,
    { resolve: vi.fn(() => ({ value: { 'lm-studio': 'cuda' }, source: 'system' })) } as never,
  );
  return { controller, invocation, billing, entitlementsService, httpService, jobService, realtimeService };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-957 F-4 — POST /agents/:slug/invocations', () => {
  it('checks the ceiling before the model runs, beside the token allowance', async () => {
    const { controller, billing, entitlementsService, invocation } = make();

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);

    expect(billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(entitlementsService.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyLlmTokens');
    expect(billing.assertSpendLimit.mock.invocationCallOrder[0]).toBeLessThan(invocation.invokeText.mock.invocationCallOrder[0]);
  });

  it('refuses over the ceiling and never calls TEXT — nothing is spent by a refused request', async () => {
    const { controller, billing, invocation } = make();
    billing.assertSpendLimit.mockRejectedValue(overLimit());

    await expect(controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined)).rejects.toBeInstanceOf(
      SpendLimitExceededException,
    );
    expect(invocation.invokeText).not.toHaveBeenCalled();
  });

  it('covers the NER half of the same route (it dispatches on the agent’s own task)', async () => {
    const { controller, billing, invocation } = make(nerAgent);
    billing.assertSpendLimit.mockRejectedValue(overLimit());

    await expect(controller.invoke('medical-ner', { text: 'hi' }, fakeRes() as never, undefined)).rejects.toBeInstanceOf(
      SpendLimitExceededException,
    );
    expect(invocation.invokeNer).not.toHaveBeenCalled();
  });

  it('does nothing when no billing service is wired — absent is "not enforced", never a refusal', async () => {
    const { controller } = make();
    // The gateway without the billing module, and every minimal fixture.
    const bare = Object.create(Object.getPrototypeOf(controller)) as AgentController;
    Object.assign(bare, controller, { billing: undefined });

    await expect(bare.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined)).resolves.toBeUndefined();
  });
});

describe('TASK-957 F-4 — POST /agents/:slug/speech', () => {
  it('checks the ceiling before the synthesis request leaves the gateway', async () => {
    const { controller, billing, httpService } = make(ttsAgent);

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);

    expect(billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(billing.assertSpendLimit.mock.invocationCallOrder[0]).toBeLessThan(httpService.axiosRef.post.mock.invocationCallOrder[0]);
  });

  it('refuses over the ceiling and synthesizes nothing', async () => {
    const { controller, billing, httpService } = make(ttsAgent);
    billing.assertSpendLimit.mockRejectedValue(overLimit());

    await expect(controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never)).rejects.toBeInstanceOf(
      SpendLimitExceededException,
    );
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
  });
});

describe('TASK-957 F-4 — POST /agents/:slug/transcriptions', () => {
  it('checks the ceiling before a job row is created or dispatched', async () => {
    const { controller, billing, jobService } = make();

    await controller.transcribe('asr-agent', { mediaId: 'media-1' });

    expect(billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(billing.assertSpendLimit.mock.invocationCallOrder[0]).toBeLessThan(jobService.createBatchJob.mock.invocationCallOrder[0]);
  });

  it('refuses over the ceiling and leaves no half-started job behind', async () => {
    const { controller, billing, jobService, realtimeService } = make();
    billing.assertSpendLimit.mockRejectedValue(overLimit());

    await expect(controller.transcribe('asr-agent', { mediaId: 'media-1' })).rejects.toBeInstanceOf(SpendLimitExceededException);
    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });
});

/**
 * The status the refusal reaches a caller as. The mapping predates this lane, but until now
 * nothing on this plane could raise it — so it is pinned HERE, where the exception first became
 * reachable, rather than assumed.
 */
describe('TASK-957 F-4 — the refusal is a 402, not a 500', () => {
  it('maps SpendLimitExceededException to 402 Payment Required with its code and metadata', async () => {
    const interceptor = new ExceptionInterceptor({ getId: () => 'corr-1', get: () => undefined } as never);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', url: '/api/v1/agents/x/invocations' }), getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
    const handler: CallHandler = { handle: () => throwError(() => overLimit()) };

    const caught = await firstValueFrom(interceptor.intercept(context, handler)).catch((err: HttpException) => err);

    expect(caught.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    const body = caught.getResponse() as { code: string; metadata?: { period: string } };
    expect(body.code).toBe('DOMAIN.SPEND_LIMIT_EXCEEDED');
    expect(body.metadata?.period).toBe('2026-09');
  });
});
