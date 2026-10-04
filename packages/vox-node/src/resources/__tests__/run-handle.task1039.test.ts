/**
 * TASK-1039 R1 — `hope.workflows.run(slug, input)` and `hope.agents.run(slug, input)` return a
 * `RunHandle`. Asserted against RECORDED protocol-v2 streams (byte shapes from the committed
 * fixture's `toSseFrame` output) including a connection drop, a resume by `seq`, a `run.resync`,
 * and the legacy frame shapes an older gateway still sends.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { HopeAPIError, ReservedRunIdentityError, RunFailedError, RunResultIntegrityError, RunStreamInterruptedError } from '../../core/errors';
import { RunHandle } from '../../core/run-handle';

const BASE = 'http://localhost:8868';
const WF = '/api/v1/workflows/note-writer/runs';
const AG = '/api/v1/agents/scribe/runs';
const TS = '2026-10-04T10:00:00.000Z';

type Factory = () => Response;
interface Call {
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/** A `fetch` double keyed by `METHOD /path`: each key serves its factories in order, the last one repeating. */
function router(routes: Record<string, Factory | Factory[]>): { fetch: typeof fetch; calls: Call[]; count: (key: string) => number } {
  const calls: Call[] = [];
  const used: Record<string, number> = {};
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    calls.push({
      method,
      path: url.pathname,
      url: url.toString(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const entry = routes[key];
    if (entry === undefined) throw new Error(`router: no route for ${key}`);
    const list = Array.isArray(entry) ? entry : [entry];
    const index = used[key] ?? 0;
    used[key] = index + 1;
    return list[Math.min(index, list.length - 1)]!();
  });
  return { fetch: impl as unknown as typeof fetch, calls, count: (key) => calls.filter((c) => `${c.method} ${c.path}` === key).length };
}

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): HopeClient {
  return new HopeClient({ baseUrl: BASE, apiKey: 'k-test', fetch: fetchImpl, maxRetries: 0, ...extra });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** One v2 SSE frame exactly as `toSseFrame` writes it. */
function v2(seq: number, type: string, data: Record<string, unknown>, nodeId?: string, runId = 'run-1'): string {
  const envelope = { seq, runId, type, ts: TS, ...(nodeId === undefined ? {} : { nodeId }), data };
  return `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function legacy(type: string, payload: Record<string, unknown>, id?: string): string {
  const envelope = { schemaVersion: 1, id: 'e', tenantId: 't', type, occurredAt: TS, correlationId: 'run-1', causationId: null, idempotencyKey: 'k', payload };
  return `event: ${type}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(envelope)}\n\n`;
}

/** An SSE body that ends cleanly after `frames`, or, with `failWith`, delivers them and THEN errors like a reset socket. */
function sse(frames: string[], failWith?: Error): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        if (!failWith) controller.close();
        return;
      }
      controller.error(failWith);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const ACCEPTED = { runId: 'run-1', status: 'started', statusUrl: `${WF}/run-1`, streamUrl: `${WF}/run-1/stream` };
const TUNING = { reconnectDelayMs: 0 };

const completed = (seq: number, extra: Record<string, unknown> = {}): string =>
  v2(seq, 'run.completed', { status: 'COMPLETED', durationMs: 1200, tokens: { in: 10, out: 20 }, ...extra });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('hope.workflows.run — starting', () => {
  it('POSTs the enveloped input with NO ?mode and returns a RunHandle', async () => {
    const { fetch, calls } = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202) });

    const run = await client(fetch).workflows.run('note-writer', { note: 'dry cough' }, TUNING);

    expect(run).toBeInstanceOf(RunHandle);
    expect(run.runId).toBe('run-1');
    expect(run.status).toBe('RUNNING');
    expect(calls[0]!.url).toBe(`${BASE}${WF}`);
    expect(calls[0]!.body).toEqual({ input: { note: 'dry cough' } });
  });

  it('sends an Idempotency-Key on EVERY start — generated when the caller supplies none', async () => {
    const { fetch, calls } = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202) });
    const hope = client(fetch);

    await hope.workflows.run('note-writer', {});
    await hope.workflows.run('note-writer', {});
    await hope.workflows.run('note-writer', {}, { idempotencyKey: 'order-42' });

    const keys = calls.map((c) => c.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(keys[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('order-42');
  });

  it('is safe to retry: a 503 on the POST is retried with the SAME Idempotency-Key', async () => {
    const { fetch, calls } = router({ [`POST ${WF}`]: [() => json({ message: 'down' }, 503), () => json(ACCEPTED, 202)] });

    const run = await client(fetch, { maxRetries: 1 }).workflows.run('note-writer', {}, TUNING);

    expect(run.runId).toBe('run-1');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
  });

  it('reports a joined run (idempotency collision) on the handle', async () => {
    const { fetch } = router({ [`POST ${WF}`]: () => json({ ...ACCEPTED, status: 'already_running' }, 202) });
    const run = await client(fetch).workflows.run('note-writer', {}, { idempotencyKey: 'k' });
    expect(run.joined).toBe(true);
  });

  it('still refuses a reserved run-identity key before the request leaves', async () => {
    const { fetch, calls } = router({});
    await expect(client(fetch).workflows.run('note-writer', { consultationId: 'c-1' })).rejects.toBeInstanceOf(ReservedRunIdentityError);
    expect(calls).toHaveLength(0);
  });

  it('keeps the previous 202-handle behaviour reachable as start()', async () => {
    const { fetch, calls } = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202) });
    const handle = await client(fetch).workflows.start('note-writer', { input: { a: 1 } }, { idempotencyKey: 'k' });
    expect(handle).toEqual(ACCEPTED);
    expect(calls[0]!.body).toEqual({ input: { a: 1 } });
  });
});

describe('RunHandle.events / .text — a recorded v2 stream', () => {
  const STREAM = [
    v2(1, 'run.started', { kind: 'workflow', slug: 'note-writer', versionNumber: 4, mode: 'stream' }),
    v2(2, 'node.started', { kind: 'core.agent', label: 'Write the note', attempt: 1 }, 'n_note'),
    v2(3, 'output.text.delta', { field: 'text', text: 'Dry ' }, 'n_note'),
    v2(4, 'output.text.delta', { field: 'text', text: 'cough.' }, 'n_note'),
    v2(5, 'output.data', { field: 'confidence', value: 0.9 }, 'n_note'),
    v2(6, 'node.completed', { status: 'COMPLETED', durationMs: 900 }, 'n_note'),
    v2(7, 'ping', {}),
    completed(8),
  ];

  async function start(streams: Factory | Factory[], extraRoutes: Record<string, Factory | Factory[]> = {}) {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: streams, ...extraRoutes });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    return { run, ...r };
  }

  it('asks for protocol v2 as SSE, with no cursor on a first connect', async () => {
    const { run, calls } = await start(() => sse(STREAM));
    await collect(run.events());
    const get = calls.find((c) => c.method === 'GET')!;
    expect(get.headers.get('x-hope-run-protocol')).toBe('2');
    expect(get.headers.get('accept')).toBe('text/event-stream');
    expect(get.headers.has('last-event-id')).toBe(false);
  });

  it('yields typed events, never the keep-alive ping, and ends after the terminal event', async () => {
    const { run } = await start(() => sse(STREAM));
    const events = await collect(run.events());
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'node.started',
      'output.text.delta',
      'output.text.delta',
      'output.data',
      'node.completed',
      'run.completed',
    ]);
    expect(run.status).toBe('COMPLETED');
    expect(run.lastSeq).toBe(8);
  });

  it('text() yields the delta text of field "text" only', async () => {
    const { run } = await start(() => sse(STREAM));
    expect(await collect(run.text())).toEqual(['Dry ', 'cough.']);
  });

  it('text({ field }) selects another text field', async () => {
    const { run } = await start(() =>
      sse([v2(1, 'output.text.delta', { field: 'text', text: 'A' }, 'n'), v2(2, 'output.text.delta', { field: 'summary', text: 'B' }, 'n'), completed(3)]),
    );
    expect(await collect(run.text({ field: 'summary' }))).toEqual(['B']);
  });

  it('accepts a seq that jumps (the public plane is filtered) — no reconnect, no error', async () => {
    const { run, count } = await start(() =>
      sse([v2(1, 'output.text.delta', { field: 'text', text: 'a' }, 'n'), v2(9, 'output.text.delta', { field: 'text', text: 'b' }, 'n'), completed(40)]),
    );
    expect(await collect(run.text())).toEqual(['a', 'b']);
    expect(count(`GET ${WF}/run-1/stream`)).toBe(1);
  });

  it('breaking out of the iteration closes the stream and NEVER cancels the run', async () => {
    const { run, calls } = await start(() => sse(STREAM));
    for await (const chunk of run.text()) {
      expect(chunk).toBe('Dry ');
      break;
    }
    expect(calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
    expect(run.status).toBe('RUNNING');
  });
});

describe('RunHandle — auto-resume by seq', () => {
  async function start(streams: Factory[], tuning: Record<string, unknown> = {}) {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: streams });
    const run = await client(r.fetch).workflows.run('note-writer', {}, { ...TUNING, ...tuning });
    return { run, ...r };
  }
  const delta = (seq: number, text: string): string => v2(seq, 'output.text.delta', { field: 'text', text }, 'n');

  it('reconnects after a clean drop with Last-Event-ID = the last seq it saw, and delivers each delta once', async () => {
    const { run, calls } = await start([
      () => sse([v2(1, 'run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }), delta(2, 'a'), delta(3, 'b')]),
      // The server replays from the cursor; a replayed seq 3 must be dropped as a duplicate.
      () => sse([delta(3, 'b'), delta(4, 'c'), completed(5)]),
    ]);

    expect(await collect(run.text())).toEqual(['a', 'b', 'c']);

    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(2);
    expect(gets[0]!.headers.has('last-event-id')).toBe(false);
    expect(gets[1]!.headers.get('last-event-id')).toBe('3');
    expect(gets[1]!.headers.get('x-hope-run-protocol')).toBe('2');
  });

  it('reconnects after a socket reset mid-read, not only after a clean close', async () => {
    const { run, calls } = await start([() => sse([delta(1, 'a')], new TypeError('terminated')), () => sse([delta(2, 'b'), completed(3)])]);
    expect(await collect(run.text())).toEqual(['a', 'b']);
    expect(calls.filter((c) => c.method === 'GET')[1]!.headers.get('last-event-id')).toBe('1');
  });

  it('a ping moves the cursor so a reconnect does not re-read what was filtered out', async () => {
    const { run, calls } = await start([() => sse([delta(1, 'a'), v2(12, 'ping', {})]), () => sse([delta(13, 'b'), completed(14)])]);
    expect(await collect(run.text())).toEqual(['a', 'b']);
    expect(calls.filter((c) => c.method === 'GET')[1]!.headers.get('last-event-id')).toBe('12');
  });

  it('gives up with RunStreamInterruptedError after the reconnect budget — and the run is untouched', async () => {
    const { run, calls } = await start([() => sse([delta(1, 'a')]), () => sse([])], { maxReconnects: 2 });
    const error = await collect(run.events()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunStreamInterruptedError);
    expect((error as RunStreamInterruptedError).lastSeq).toBe(1);
    expect(calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
  });

  it('does not retry a 404 — that is "not your run", not a drop', async () => {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: () => json({ message: 'nope' }, 404) });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    await expect(collect(run.events())).rejects.toBeInstanceOf(HopeAPIError);
    expect(r.count(`GET ${WF}/run-1/stream`)).toBe(1);
  });

  it('events({ after }) resumes a persisted cursor in another process', async () => {
    const r = router({ [`GET ${WF}/run-1/stream`]: () => sse([delta(8, 'z'), completed(9)]) });
    const run = client(r.fetch).workflows.attach('note-writer', 'run-1', TUNING);
    expect(await collect(run.text({ after: 7 }))).toEqual(['z']);
    expect(r.calls[0]!.headers.get('last-event-id')).toBe('7');
  });
});

describe('RunHandle — run.resync', () => {
  const delta = (seq: number, text: string, nodeId = 'n'): string => v2(seq, 'output.text.delta', { field: 'text', text }, nodeId);
  const resync = (seq: number, reason: string, snapshot: Record<string, unknown>): string =>
    v2(seq, 'run.resync', { reason, snapshot: { status: 'RUNNING', lastSeq: seq, nodes: {}, outputs: {}, ...snapshot } });

  async function start(streams: Factory[]) {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: streams });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    return { run, ...r };
  }

  it('surfaces the resync, resets the cursor to the server-sent seq, and keeps going', async () => {
    const { run, calls } = await start([
      () => sse([delta(1, 'a'), delta(2, 'b')]),
      () => sse([resync(2, 'gap', {}), delta(3, 'c'), completed(4)]),
    ]);
    const events = await collect(run.events());
    expect(events.map((e) => e.type)).toEqual(['output.text.delta', 'output.text.delta', 'run.resync', 'output.text.delta', 'run.completed']);
    expect(calls.filter((c) => c.method === 'GET')[1]!.headers.get('last-event-id')).toBe('2');
  });

  it('text() emits only the part of a snapshot it has not yet yielded', async () => {
    const { run } = await start([
      () => sse([delta(1, 'Dry '), delta(2, 'cou')]),
      () => sse([resync(9, 'gap', { outputs: { n: { text: 'Dry cough, 3 days' } } }), delta(10, '.'), completed(11)]),
    ]);
    expect((await collect(run.text())).join('')).toBe('Dry cough, 3 days.');
  });

  it('treats a lower resync cursor as authoritative and accepts events after it', async () => {
    const { run } = await start([() => sse([delta(50, 'x'), resync(3, 'cursor_invalid', { outputs: { n: { text: 'x' } } }), delta(4, 'y'), completed(5)])]);
    expect(await collect(run.text())).toEqual(['x', 'y']);
    expect(run.lastSeq).toBe(5);
  });

  it('an expired-run resync carrying a terminal snapshot ends the iteration and sets the outcome', async () => {
    const { run } = await start([
      () =>
        sse([
          resync(7, 'expired', {
            status: 'COMPLETED',
            outputs: { n: { text: 'whole note' } },
            result: { kind: 'inline', value: { text: 'whole note' } },
          }),
        ]),
    ]);
    expect(await collect(run.text())).toEqual(['whole note']);
    expect(run.status).toBe('COMPLETED');
    expect((await run.wait()).result).toEqual({ kind: 'inline', value: { text: 'whole note' } });
  });
});

describe('RunHandle.wait', () => {
  it('streams by default and resolves with the terminal outcome', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1/stream`]: () => sse([completed(2, { degraded: true, result: { kind: 'inline', value: { text: 't' } } })]),
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);

    const outcome = await run.wait();

    expect(outcome).toMatchObject({ runId: 'run-1', status: 'COMPLETED', durationMs: 1200, degraded: true, tokens: { in: 10, out: 20 } });
    expect(r.count(`GET ${WF}/run-1`)).toBe(0);
  });

  it('wait() resolves — it does not throw — for a failed run, and carries the PUBLIC error', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1/stream`]: () =>
        sse([v2(2, 'run.failed', { status: 'FAILED', durationMs: 5, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' } })]),
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    const outcome = await run.wait();
    expect(outcome.status).toBe('FAILED');
    expect(outcome.error).toEqual({ code: 'MODEL_ERROR', message: 'The model returned an error.' });
  });

  it('{ poll: true } polls GET …/runs/:runId and never opens the stream', async () => {
    const status = (s: string) => () =>
      json({ runId: 'run-1', slug: 'note-writer', workflowVersionNumber: 1, status: s, stages: [], startedAt: TS, endedAt: s === 'RUNNING' ? null : TS, resultRef: null, degraded: false });
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1`]: [status('RUNNING'), status('RUNNING'), status('COMPLETED')] });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);

    const outcome = await run.wait({ poll: true, intervalMs: 0 });

    expect(outcome.status).toBe('COMPLETED');
    expect(r.count(`GET ${WF}/run-1`)).toBe(3);
    expect(r.count(`GET ${WF}/run-1/stream`)).toBe(0);
    expect(run.status).toBe('COMPLETED');
  });

  it('falls back to polling when the stream cannot be re-established', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1/stream`]: () => sse([]),
      [`GET ${WF}/run-1`]: () => json({ runId: 'run-1', slug: 'note-writer', workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: TS, endedAt: TS, resultRef: null, degraded: false }),
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, { ...TUNING, maxReconnects: 1 });
    expect((await run.wait({ intervalMs: 0 })).status).toBe('COMPLETED');
  });

  it('an aborted signal stops a poll without cancelling the run', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1`]: () => json({ runId: 'run-1', slug: 's', workflowVersionNumber: 1, status: 'RUNNING', stages: [], startedAt: TS, endedAt: null, resultRef: null, degraded: false }),
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    const controller = new AbortController();
    const waiting = run.wait({ poll: true, intervalMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toThrow();
    expect(r.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
  });
});

describe('RunHandle.result', () => {
  const STREAM_DONE = () => sse([completed(2)]);

  async function start(extra: Record<string, Factory | Factory[]>, stream: Factory = STREAM_DONE) {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: stream, ...extra });
    const run = await client(r.fetch).workflows.run<{ note: string }, { text: string }>('note-writer', { note: 'x' }, TUNING);
    return { run, ...r };
  }

  it('waits for the run, then returns an inline result (typed through the TOutput generic)', async () => {
    const { run, calls } = await start({ [`GET ${WF}/run-1/result`]: () => json({ text: 'Dry cough.' }, 200, { 'x-hope-result-kind': 'inline' }) });
    const result = await run.result();
    expect(result?.text).toBe('Dry cough.');
    const order = calls.map((c) => c.path.replace(WF, ''));
    expect(order.indexOf('/run-1/stream')).toBeLessThan(order.indexOf('/run-1/result'));
  });

  it('returns null for a 204 — the run delivered nothing', async () => {
    const { run } = await start({ [`GET ${WF}/run-1/result`]: () => new Response(null, { status: 204 }) });
    expect(await run.result()).toBeNull();
  });

  it('follows a signed URL for a ref result — WITHOUT the gateway credentials — and verifies sha256', async () => {
    const payload = JSON.stringify({ text: 'a very large note' });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const ref = { url: 'https://objects.example/hope-results/abc?sig=1', expiresAt: '2026-10-04T11:00:00.000Z', sizeBytes: payload.length, sha256 };
    const { run, calls } = await start({
      [`GET ${WF}/run-1/result`]: () => json(ref, 200, { 'x-hope-result-kind': 'ref' }),
      'GET /hope-results/abc': () => new Response(payload, { status: 200 }),
    });

    expect(await run.result()).toEqual({ text: 'a very large note' });

    const signed = calls.find((c) => c.url.startsWith('https://objects.example'))!;
    expect(signed.headers.has('x-api-key')).toBe(false);
    expect(signed.headers.has('authorization')).toBe(false);
  });

  it('refuses a signed-URL body that does not hash to the declared sha256', async () => {
    const ref = { url: 'https://objects.example/hope-results/abc?sig=1', expiresAt: '2026-10-04T11:00:00.000Z', sizeBytes: 3, sha256: 'ab'.repeat(32) };
    const { run } = await start({
      [`GET ${WF}/run-1/result`]: () => json(ref, 200, { 'x-hope-result-kind': 'ref' }),
      'GET /hope-results/abc': () => new Response('{"text":"tampered"}', { status: 200 }),
    });
    await expect(run.result()).rejects.toBeInstanceOf(RunResultIntegrityError);
  });

  it('asks the route again for a fresh URL when the signed one has expired', async () => {
    const payload = JSON.stringify({ text: 'ok' });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const ref = (n: number) => () =>
      json({ url: `https://objects.example/hope-results/v${n}`, expiresAt: '2026-10-04T11:00:00.000Z', sizeBytes: payload.length, sha256 }, 200, { 'x-hope-result-kind': 'ref' });
    const { run, count } = await start({
      [`GET ${WF}/run-1/result`]: [ref(1), ref(2)],
      'GET /hope-results/v1': () => new Response('expired', { status: 403 }),
      'GET /hope-results/v2': () => new Response(payload, { status: 200 }),
    });
    expect(await run.result()).toEqual({ text: 'ok' });
    expect(count(`GET ${WF}/run-1/result`)).toBe(2);
  });

  it('throws RunFailedError — carrying the public error — when the run did not complete', async () => {
    const { run, count } = await start(
      {},
      () => sse([v2(2, 'run.failed', { status: 'TIMED_OUT', durationMs: 9, error: { code: 'RUN_TIMED_OUT', message: 'The run exceeded its time limit.' } })]),
    );
    const error = await run.result().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunFailedError);
    expect(error).toMatchObject({ runId: 'run-1', status: 'TIMED_OUT', code: 'RUN_TIMED_OUT' });
    expect(count(`GET ${WF}/run-1/result`)).toBe(0);
  });

  it('surfaces a 410 (result past retention) as a typed API error, unretried', async () => {
    const { run, count } = await start({ [`GET ${WF}/run-1/result`]: () => json({ code: 'RESULT_EXPIRED', message: 'gone' }, 410) });
    const error = await run.result().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HopeAPIError);
    expect((error as HopeAPIError).status).toBe(410);
    expect(count(`GET ${WF}/run-1/result`)).toBe(1);
  });

  it('does not stream again when an earlier iteration already saw the run finish', async () => {
    const { run, count } = await start({ [`GET ${WF}/run-1/result`]: () => json({ text: 'x' }, 200, { 'x-hope-result-kind': 'inline' }) });
    await collect(run.text());
    await run.result();
    expect(count(`GET ${WF}/run-1/stream`)).toBe(1);
  });
});

describe('RunHandle.cancel', () => {
  it('POSTs …/cancel once, however often it is called', async () => {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`POST ${WF}/run-1/cancel`]: () => json({ runId: 'run-1', status: 'cancel_requested' }) });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);

    const [a, b] = await Promise.all([run.cancel(), run.cancel()]);
    const c = await run.cancel();

    expect(a).toEqual({ runId: 'run-1', status: 'cancel_requested' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(r.count(`POST ${WF}/run-1/cancel`)).toBe(1);
  });

  it('does not call the gateway for a run it has already seen finish', async () => {
    const r = router({ [`POST ${WF}`]: () => json(ACCEPTED, 202), [`GET ${WF}/run-1/stream`]: () => sse([completed(2)]) });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    await run.wait();
    expect(await run.cancel()).toEqual({ runId: 'run-1', status: 'COMPLETED' });
    expect(r.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
  });

  it('a failed cancel is retryable (the memo is not poisoned by a rejection)', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`POST ${WF}/run-1/cancel`]: [() => json({ message: 'boom' }, 500), () => json({ runId: 'run-1', status: 'cancel_requested' })],
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    await expect(run.cancel()).rejects.toBeInstanceOf(HopeAPIError);
    await expect(run.cancel()).resolves.toMatchObject({ status: 'cancel_requested' });
  });
});

describe('RunHandle — against an older gateway (legacy frames, one release)', () => {
  it('streams text from workflow.token.delta, resumes by the OPAQUE frame id, and ends on workflow.run.completed', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1/stream`]: [
        () =>
          sse([
            legacy('workflow.run.progress', { runId: 'run-1', status: 'RUNNING', stages: [] }),
            legacy('workflow.token.delta', { nodeId: 'n', sequence: 1, text: 'Hel' }, '1700000000000-0'),
            legacy('workflow.token.delta', { nodeId: 'n', sequence: 2, text: 'lo' }, '1700000000001-0'),
          ]),
        () => sse([legacy('workflow.token.delta', { nodeId: 'n', sequence: 3, text: '!' }, '1700000000002-0'), legacy('workflow.run.completed', { status: 'SUCCEEDED' }, '1700000000003-0')]),
      ],
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);

    expect((await collect(run.text())).join('')).toBe('Hello!');

    expect(r.calls.filter((c) => c.method === 'GET')[1]!.headers.get('last-event-id')).toBe('1700000000001-0');
    expect(run.status).toBe('COMPLETED');
  });

  it('maps a legacy FAILED completion so wait() reports it', async () => {
    const r = router({
      [`POST ${WF}`]: () => json(ACCEPTED, 202),
      [`GET ${WF}/run-1/stream`]: () => sse([legacy('workflow.run.completed', { status: 'FAILED', reason: 'MODEL_ERROR' }, '1-0')]),
    });
    const run = await client(r.fetch).workflows.run('note-writer', {}, TUNING);
    expect(await run.wait()).toMatchObject({ status: 'FAILED', error: { code: 'MODEL_ERROR' } });
  });
});

describe('hope.agents.run', () => {
  const AGENT_ACCEPTED = {
    runId: 'run-1',
    status: 'RUNNING',
    links: { self: `${AG}/run-1`, events: `${AG}/run-1/events`, result: `${AG}/run-1/result`, cancel: `${AG}/run-1/cancel` },
  };
  const agentDelta = (seq: number, text: string): string => v2(seq, 'output.text.delta', { field: 'text', text }, 'agent');

  it('POSTs the FLAT input (no { input } envelope) with an Idempotency-Key and returns a RunHandle', async () => {
    const r = router({ [`POST ${AG}`]: () => json(AGENT_ACCEPTED, 202) });
    const run = await client(r.fetch).agents.run('scribe', { text: 'hello' }, TUNING);

    expect(run).toBeInstanceOf(RunHandle);
    expect(run.runId).toBe('run-1');
    expect(r.calls[0]!.body).toEqual({ text: 'hello' });
    expect(r.calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('streams text from …/events (nodeId "agent") and reads the inline result', async () => {
    const r = router({
      [`POST ${AG}`]: () => json(AGENT_ACCEPTED, 202),
      [`GET ${AG}/run-1/events`]: () => sse([v2(1, 'node.started', { kind: 'agent' }, 'agent'), agentDelta(2, 'Hi '), agentDelta(3, 'there'), completed(4)]),
      [`GET ${AG}/run-1/result`]: () => json({ text: 'Hi there' }, 200, { 'x-hope-result-kind': 'inline' }),
    });
    const run = await client(r.fetch).agents.run<{ text: string }, { text: string }>('scribe', { text: 'hello' }, TUNING);

    expect(await collect(run.text())).toEqual(['Hi ', 'there']);
    expect(await run.result()).toEqual({ text: 'Hi there' });
    expect(r.calls.find((c) => c.path.endsWith('/events'))!.headers.get('x-hope-run-protocol')).toBe('2');
  });

  it('polls the agent status route and reads its public error', async () => {
    const r = router({
      [`POST ${AG}`]: () => json(AGENT_ACCEPTED, 202),
      [`GET ${AG}/run-1`]: [
        () => json({ runId: 'run-1', agentSlug: 'scribe', status: 'RUNNING', durationMs: null, error: null }),
        () => json({ runId: 'run-1', agentSlug: 'scribe', status: 'FAILED', durationMs: 40, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' } }),
      ],
    });
    const run = await client(r.fetch).agents.run('scribe', {}, TUNING);
    expect(await run.wait({ poll: true, intervalMs: 0 })).toMatchObject({ status: 'FAILED', durationMs: 40, error: { code: 'MODEL_ERROR' } });
  });

  it('cancels at …/runs/:runId/cancel', async () => {
    const r = router({ [`POST ${AG}`]: () => json(AGENT_ACCEPTED, 202), [`POST ${AG}/run-1/cancel`]: () => json({ runId: 'run-1', status: 'CANCELED' }) });
    const run = await client(r.fetch).agents.run('scribe', {}, TUNING);
    expect(await run.cancel()).toEqual({ runId: 'run-1', status: 'CANCELED' });
    expect(run.status).toBe('CANCELED');
  });

  it('attach() builds a handle for a run started elsewhere, without any request', () => {
    const r = router({});
    const run = client(r.fetch).agents.attach('scribe', 'run-9');
    expect(run.runId).toBe('run-9');
    expect(r.calls).toHaveLength(0);
  });
});
