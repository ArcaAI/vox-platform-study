/**
 * TASK-1038 OD-26 — the agent RUN routes on the business plane.
 *
 *   POST /agents/:slug/runs                 → 202 { runId, status, links }  (Idempotency-Key honoured)
 *   GET  /agents/:slug/runs/:runId          → the run's status
 *   GET  /agents/:slug/runs/:runId/result   → inline result / 204 / 409 RUN_NOT_TERMINAL
 *   POST /agents/:slug/runs/:runId/cancel   → idempotent
 *   GET  /agents/:slug/runs/:runId/events   → SSE, run protocol v2, resumable
 *
 * Same authorisation as `POST /agents/:slug/invocations` (bare `@Authorize()` + the invocation
 * scopes for both machine classes). The request is validated and metered-prechecked BEFORE the
 * 202, so a refusal is the caller's answer rather than a FAILED run.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { RUN_EVENTS_KEY, parseSseFrame } from '@arcaai/async-contract';
import { AgentController } from '../agent.controller';
import { AgentRunService } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';

const TENANT = '50000000-0000-0000-0000-000000000000';
const RESOLVED = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'scribe',
  versionNumber: 2,
  task: 'TEXT_GENERATION',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm', slug: 'gpt-x', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
  },
  models: [],
};

let redis: FakeAgentRunRedis;

/** A hub over the fake streams: `readNow` / `read` return what is stored after the cursor id. */
function fakeHub() {
  const after = (key: string, cursor: string) =>
    (redis.streams.get(key) ?? []).filter(([id]) => cursor === '0-0' || Number(id.split('-')[0]) > Number(cursor.split('-')[0])).map(([id, fields]) => ({ id, fields }));
  return {
    available: () => true,
    readNow: vi.fn(async (key: string, cursor: string) => after(key, cursor)),
    read: vi.fn(async (key: string, cursor: string) => after(key, cursor)),
  };
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    headers,
    chunks,
    statusCode: 0,
    ended: false,
    setHeader: vi.fn((k: string, v: string) => void (headers[k] = v)),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => void chunks.push(String(chunk))),
    end: vi.fn(() => void (res.ended = true)),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    on: vi.fn(),
  };
  return res;
}

function make() {
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => [] as string[]),
    invokeText: vi.fn(async () => ({ text: 'The note.', provider: 'lm-studio', model: 'gpt-x', usage: { promptTokens: 10, completionTokens: 3 } })),
    invokeNer: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) };
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const usageLedger = { recordUsage: vi.fn(async () => ({ written: 1 })) };
  const runs = new AgentRunService(redis as never, { resolvePlatform: () => ({ value: 24 }), resolve: () => ({ value: 30 }) } as never);
  const hub = fakeHub();
  const controller = new AgentController(
    {} as never,
    resolver as never,
    invocation as never,
    cls as never,
    {} as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    entitlementsService as never,
    usageLedger as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runs,
    hub as never,
  );
  return { controller, resolver, invocation, entitlementsService, runs, hub };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  redis = new FakeAgentRunRedis();
});

describe('route metadata — the invocation route’s posture', () => {
  const reflector = new Reflector();
  for (const method of ['startRun', 'getRun', 'getRunResult', 'cancelRun', 'runEvents'] as const) {
    it(`${method} carries @Authorize() and the invocation scopes`, () => {
      const handler = AgentController.prototype[method];
      expect(handler).toBeTypeOf('function');
      expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, AgentController])).toEqual([]);
      expect(reflector.get(API_KEY_REQUIRED_SCOPES, handler)).toEqual(['agent:invocation:write']);
      expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:agent:invocation:write']);
    });
  }
});

describe('POST /agents/:slug/runs', () => {
  it('answers 202 { runId, status, links } and runs the agent in the background', async () => {
    const { controller, invocation } = make();
    const answer = await controller.startRun('scribe', { message: 'Summarise.' }, undefined);
    expect(answer).toMatchObject({ status: 'RUNNING', links: { self: `/api/v1/agents/scribe/runs/${answer.runId}` } });
    await flush();
    expect(invocation.invokeText).toHaveBeenCalledWith(RESOLVED, TENANT, { message: 'Summarise.' }, 'blocking');
    const status = await controller.getRun('scribe', answer.runId);
    expect(status).toMatchObject({ runId: answer.runId, status: 'COMPLETED', agentSlug: 'scribe', versionNumber: 2 });
  });

  it('refuses an invalid body with 400 BEFORE any run exists', async () => {
    const { controller, invocation } = make();
    invocation.inputProblems.mockReturnValue(['missing message']);
    await expect(controller.startRun('scribe', {}, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.strings.size).toBe(0);
  });

  it('prechecks the LLM-token allowance before the 202', async () => {
    const { controller, entitlementsService } = make();
    entitlementsService.assertMeterQuota.mockRejectedValueOnce(new ConflictException('quota'));
    await expect(controller.startRun('scribe', { message: 'x' }, undefined)).rejects.toBeInstanceOf(ConflictException);
  });

  it('honours Idempotency-Key: same key + same body → same runId; a different body → 409', async () => {
    const { controller, invocation } = make();
    const a = await controller.startRun('scribe', { message: 'x' }, 'key-1');
    const b = await controller.startRun('scribe', { message: 'x' }, 'key-1');
    expect(b.runId).toBe(a.runId);
    await expect(controller.startRun('scribe', { message: 'y' }, 'key-1')).rejects.toBeInstanceOf(ConflictException);
    await flush();
    expect(invocation.invokeText).toHaveBeenCalledTimes(1);
  });

  it('refuses a task that is not a one-shot invocation (TTS has /speech, ASR /transcriptions)', async () => {
    const { controller, resolver } = make();
    resolver.resolve.mockResolvedValueOnce({ ...RESOLVED, task: 'TEXT_TO_SPEECH' } as never);
    await expect(controller.startRun('scribe', { text: 'x' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GET …/result and POST …/cancel', () => {
  it('409 RUN_NOT_TERMINAL while running; the inline value once COMPLETED', async () => {
    const { controller, invocation } = make();
    let release!: (value: unknown) => void;
    invocation.invokeText.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never);
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await expect(controller.getRunResult('scribe', runId, fakeRes() as never)).rejects.toMatchObject({ response: { code: 'RUN_NOT_TERMINAL' } });

    release({ text: 'done', provider: 'lm-studio', model: 'gpt-x', usage: null });
    await flush();
    const res = fakeRes();
    expect(await controller.getRunResult('scribe', runId, res as never)).toEqual({ text: 'done' });
    expect(res.headers['X-Hope-Result-Kind']).toBe('inline');
  });

  it('cancel is idempotent and a cancelled run has no result (204)', async () => {
    const { controller, invocation } = make();
    invocation.invokeText.mockImplementationOnce(() => new Promise(() => undefined) as never);
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    expect((await controller.cancelRun('scribe', runId)).status).toBe('CANCELED');
    expect((await controller.cancelRun('scribe', runId)).status).toBe('CANCELED');
    const res = fakeRes();
    expect(await controller.getRunResult('scribe', runId, res as never)).toBeUndefined();
    expect(res.statusCode).toBe(204);
  });

  it('another slug cannot read the run — 404', async () => {
    const { controller } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await expect(controller.getRun('another', runId)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET …/events — run protocol v2 over SSE', () => {
  function frames(res: ReturnType<typeof fakeRes>) {
    return res.chunks
      .join('')
      .split('\n\n')
      .filter((frame) => frame.startsWith('event:'))
      .map((frame) => parseSseFrame(`${frame}\n\n`));
  }

  it('replays the whole run from the start and closes after the terminal event', async () => {
    const { controller } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    const res = fakeRes();
    await controller.runEvents('scribe', runId, { headers: {}, query: {} } as never, res as never);
    const parsed = frames(res);
    expect(parsed.every((frame) => frame.kind === 'event')).toBe(true);
    const types = parsed.map((frame) => (frame.kind === 'event' ? frame.event.type : null));
    expect(types).toEqual(['run.started', 'node.started', 'output.text.delta', 'node.completed', 'run.completed']);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.ended).toBe(true);
  });

  it('resumes after Last-Event-ID', async () => {
    const { controller } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    const res = fakeRes();
    await controller.runEvents('scribe', runId, { headers: { 'last-event-id': '3' }, query: {} } as never, res as never);
    const seqs = frames(res).map((frame) => (frame.kind === 'event' ? frame.event.seq : -1));
    expect(seqs).toEqual([4, 5]);
  });

  it('answers run.resync { cursor_invalid } for a cursor past the end', async () => {
    const { controller } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    const res = fakeRes();
    await controller.runEvents('scribe', runId, { headers: {}, query: { after: '99' } } as never, res as never);
    const first = frames(res)[0];
    expect(first.kind === 'event' && first.event.type).toBe('run.resync');
    expect(first.kind === 'event' && (first.event.data as { reason: string }).reason).toBe('cursor_invalid');
  });

  it('refuses a protocol other than 2 with 400', async () => {
    const { controller } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await expect(controller.runEvents('scribe', runId, { headers: {}, query: { protocol: '1' } } as never, fakeRes() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a foreign run is a 404 before any frame is written', async () => {
    const { controller } = make();
    await expect(controller.runEvents('scribe', 'nope', { headers: {}, query: {} } as never, fakeRes() as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  void RUN_EVENTS_KEY;
});
