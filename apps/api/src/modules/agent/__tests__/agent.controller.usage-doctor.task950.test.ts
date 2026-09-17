/**
 * TASK-950 (decision 3, fast win) — an agent invocation's usage row names the clinician it acted
 * for.
 *
 * `AgentInvocationService` writes no domain row and broadcasts no sys-event, so `AiUsageEvent` is
 * the ONLY durable, indexed, per-call record this plane produces — and `doctorId` on it was always
 * null, even when the caller had named a clinician through the agent's context schema. That is the
 * same column a consultation-driven LLM call already fills, so filling it here puts both on one
 * channel rather than inventing a second.
 *
 * Pinned in both directions and on both paths:
 *
 *  · BLOCKING and STREAM each emit through a different builder (`buildLlmUsageInputFromTokenCounts`
 *    vs `LlmStreamUsageCollector.take`), so a fix applied to one says nothing about the other;
 *  · the stream path emits from THREE teardown handlers (`end`, `error`, the client's `close`) and
 *    every one of them must carry the same id — a row written on an aborted stream is still a row
 *    someone is billed for;
 *  · a human or API-key caller keeps `doctorId: null`, which is not a regression to guard against
 *    but the honest answer: no acting user was resolved, because none was named;
 *  · the HTTP response body is unchanged. The caller supplied the staff identifier; echoing back
 *    the HOPE user it maps to would make every invocation a directory lookup.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';
const ACTING_USER = '70000000-0000-0000-0000-0000000009e5';

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
  },
  models: [],
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

function make() {
  const agentService = { listPublished: vi.fn(), getPublishedBySlug: vi.fn() };
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => []),
    invokeText: vi.fn(async (): Promise<unknown> => ({})),
    buildSpeechRequest: vi.fn(),
    guardrailDisposition: vi.fn(async (): Promise<'screened'> => 'screened'),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) };
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const usageLedger = { recordUsage: vi.fn(async (_batch: unknown) => ({ written: 1 })) };
  const controller = new AgentController(
    agentService as never,
    resolver as never,
    invocation as never,
    cls as never,
    {} as never, // httpService
    { getConfigValue: () => 'http://tts' } as never,
    undefined, // secretsService
    undefined, // ttsResolver
    entitlementsService as never,
    usageLedger as never,
    { createBatchJob: vi.fn(), failJob: vi.fn() } as never,
    { dispatchDramatiqJob: vi.fn() } as never,
    { fetchById: vi.fn() } as never,
    { resolve: vi.fn() } as never,
  );
  return { controller, invocation, usageLedger };
}

/** A blocking result carrying token counts, so a ledger row is actually produced. */
const blockingResult = (actingUserId?: string) => ({
  text: 'hello',
  provider: 'lm-studio',
  model: 'lms-gemma-4-e2b-it-qat',
  usage: { promptTokens: 120, completionTokens: 40 },
  promptFragments: null,
  ...(actingUserId ? { actingUserId } : {}),
});

/** The terminal SSE frame `apps/text` writes — the only frame the collector meters. */
const TERMINAL_USAGE_FRAME = `data: ${JSON.stringify({
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
})}\n\n`;

/** The `common` block of a recorded batch — where every attribution dimension, `doctorId` included, lives. */
const commonOf = (batch: unknown) => (batch as { common: Record<string, unknown> }).common;

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-950 — AiUsageEvent.doctorId on an agent invocation', () => {
  it('blocking: stamps the acting user the service resolved', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult(ACTING_USER));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    expect(commonOf(usageLedger.recordUsage.mock.calls[0]?.[0])).toMatchObject({ operation: 'generate', doctorId: ACTING_USER });
  });

  it('blocking: stamps null when the service resolved nobody — a human caller names no one else', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(commonOf(usageLedger.recordUsage.mock.calls[0]?.[0]).doctorId).toBeNull();
  });

  it('blocking: the response body is UNCHANGED — the acting user is internal, never echoed', async () => {
    const { controller, invocation } = make();
    invocation.invokeText.mockResolvedValue(blockingResult(ACTING_USER));
    const res = fakeRes();

    await controller.invoke('clinic-summarizer', { text: 'hi' }, res as never, undefined);

    expect(res.body).toMatchObject({ agentSlug: 'clinic-summarizer', output: { text: 'hello' } });
    expect(res.body).not.toHaveProperty('actingUserId');
  });

  it('stream: stamps the acting user on the row the terminal frame produces', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream, actingUserId: ACTING_USER });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(TERMINAL_USAGE_FRAME);
    stream.end();
    await settle();

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    expect(commonOf(usageLedger.recordUsage.mock.calls[0]?.[0])).toMatchObject({ operation: 'generate.stream', doctorId: ACTING_USER });
  });

  it('stream: stamps null when none was resolved', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(TERMINAL_USAGE_FRAME);
    stream.end();
    await settle();

    expect(commonOf(usageLedger.recordUsage.mock.calls[0]?.[0]).doctorId).toBeNull();
  });

  it('stream: the ABORT row carries it too — an interrupted stream still spent those tokens', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream, actingUserId: ACTING_USER });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(TERMINAL_USAGE_FRAME);
    // Let the `data` handler observe the frame before the socket dies: a PassThrough emits `data`
    // on a later tick, and tearing down first would meter nothing and prove nothing.
    await settle();
    stream.emit('error', new Error('socket died'));
    await settle();

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    expect(commonOf(usageLedger.recordUsage.mock.calls[0]?.[0])).toMatchObject({ doctorId: ACTING_USER, operation: 'generate.stream' });
  });
});
