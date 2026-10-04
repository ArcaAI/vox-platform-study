/**
 * TASK-1038 E2 — review fixes on the agent RUN routes.
 *
 * - fix 4 (R2): the run's executor hands the model call an `AbortSignal` (cancel / ceiling stop it);
 * - fix 8: `…/events` ends a TERMINAL run whose terminal frame never reached the stream with a
 *   terminal `run.resync { reason: 'gap', snapshot }` — never a silent close;
 * - fix 10: an `Idempotency-Key` that already started a run JOINS it before any precheck (quota,
 *   spend), so a retry of an accepted request is never refused by a meter it already passed;
 * - fix 11: the 409 `IDEMPOTENCY_KEY_REUSED` body never names the other request's `runId`.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, HttpException } from '@nestjs/common';
import { RUN_EVENTS_KEY, RUN_SEQ_KEY, parseSseFrame } from '@arcaai/async-contract';
import { AgentController } from '../agent.controller';
import { AgentRunService } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';
import { FakeWorkflowRunRepository } from './fake-workflow-run-repository';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '51000000-0000-0000-0000-000000000000';
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
/** The run read model — shared across controller instances, as one Postgres is across gateways. */
let repository: FakeWorkflowRunRepository;

/** A hub over the fake streams: `readNow` / `read` return what is stored after the cursor id. */
function fakeHub() {
  const after = (key: string, cursor: string) =>
    (redis.streams.get(key) ?? [])
      .filter(([id]) => cursor === '0-0' || Number(id.split('-')[0]) > Number(cursor.split('-')[0]))
      .map(([id, fields]) => ({ id, fields }));
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

function make(tenantId: string = TENANT) {
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => [] as string[]),
    invokeText: vi.fn(async () => ({ text: 'The note.', provider: 'lm-studio', model: 'gpt-x', usage: { promptTokens: 10, completionTokens: 3 } })),
    invokeNer: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : key === 'user' ? { id: 'u1' } : undefined)) };
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const usageLedger = { recordUsage: vi.fn(async () => ({ written: 1 })) };
  const runs = new AgentRunService(repository as never, redis as never, { resolvePlatform: () => ({ value: 24 }), resolve: () => ({ value: 30 }) } as never);
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
  repository = new FakeWorkflowRunRepository();
});


describe('fix 4 — the executor hands the model call an AbortSignal', () => {
  it('TEXT: invokeText receives { signal } (5th argument), not yet aborted', async () => {
    const { controller, invocation } = make();
    await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    const options = invocation.invokeText.mock.calls.at(-1)?.[4] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancel aborts that signal while the call is in flight', async () => {
    const { controller, invocation } = make();
    let seen: AbortSignal | undefined;
    invocation.invokeText.mockImplementationOnce(((_r: unknown, _t: unknown, _b: unknown, _m: unknown, options: { signal: AbortSignal }) => {
      seen = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('canceled'))));
    }) as never);
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    expect(seen?.aborted).toBe(false);
    await controller.cancelRun('scribe', runId);
    expect(seen?.aborted).toBe(true);
  });
});

describe('fix 10 — Idempotency-Key joins BEFORE the prechecks', () => {
  it('a retry of an accepted request joins its run even when the allowance is now exhausted', async () => {
    const { controller, entitlementsService, invocation } = make();
    const first = await controller.startRun('scribe', { message: 'x' }, 'key-1');
    entitlementsService.assertMeterQuota.mockRejectedValue(new HttpException('quota', 429));
    invocation.inputProblems.mockReturnValue(['would refuse a fresh request']);
    const retry = await controller.startRun('scribe', { message: 'x' }, 'key-1');
    expect(retry.runId).toBe(first.runId);
    expect(entitlementsService.assertMeterQuota).toHaveBeenCalledTimes(1);
  });

  it('a different body under the same key is 409 before any precheck', async () => {
    const { controller, entitlementsService } = make();
    await controller.startRun('scribe', { message: 'x' }, 'key-2');
    entitlementsService.assertMeterQuota.mockClear();
    await expect(controller.startRun('scribe', { message: 'y' }, 'key-2')).rejects.toBeInstanceOf(ConflictException);
    expect(entitlementsService.assertMeterQuota).not.toHaveBeenCalled();
  });
});

describe('fix 11 — the 409 never names the other request’s run', () => {
  it('IDEMPOTENCY_KEY_REUSED carries a code and a message, and no runId', async () => {
    const { controller } = make();
    await controller.startRun('scribe', { message: 'x' }, 'key-3');
    const refusal = await controller.startRun('scribe', { message: 'y' }, 'key-3').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictException);
    const response = (refusal as ConflictException).getResponse() as Record<string, unknown>;
    expect(response.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(response).not.toHaveProperty('runId');
  });
});

describe('fix 8 — a terminal run with no terminal frame ends with a terminal resync', () => {
  it('answers run.resync { reason: gap, snapshot (terminal) } and closes, instead of a silent close', async () => {
    const { controller, runs } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await flush();
    // The stream lost its tail: keep only the first two stored events (run.started, node.started).
    const stored = redis.streams.get(RUN_EVENTS_KEY(runId)) ?? [];
    redis.streams.set(RUN_EVENTS_KEY(runId), stored.slice(0, 2));
    redis.strings.set(RUN_SEQ_KEY(runId), '2');
    expect((await runs.get(TENANT, 'scribe', runId)).status).toBe('COMPLETED');

    const res = fakeRes();
    await controller.runEvents('scribe', runId, { headers: {}, query: {} } as never, res as never);
    const frames = res.chunks
      .join('')
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('event:'))
      .map((chunk) => parseSseFrame(`${chunk}\n\n`));
    const last = frames.at(-1);
    expect(last?.kind).toBe('event');
    const event = last?.kind === 'event' ? (last.event as { type: string; seq: number; data: { reason: string; snapshot: { status: string; lastSeq: number } } }) : null;
    expect(event?.type).toBe('run.resync');
    expect(event?.data.reason).toBe('gap');
    expect(event?.data.snapshot.status).toBe('COMPLETED');
    expect(event?.seq).toBe(event?.data.snapshot.lastSeq);
    expect(res.ended).toBe(true);
  });
});
