/**
 * `handle.startCapture(sttSessionId)` and `handle.refresh()` — the two verbs a caller that runs its
 * OWN speech-to-text (a broker that already holds an STT session and its socket) needs: bind that
 * session to the consultation without the SDK opening a second one, and re-read the consultation
 * on demand. Both — like every handle verb — send `X-Hope-Lifecycle: 2`.
 */
import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../core/transport';
import { ConsultationHandle, type ConsultationHandleDeps } from '../resources/consultation-handle';

const BASE = 'http://localhost:8868';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Responder = (call: Call) => Response | Promise<Response>;

function makeFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: Call[] = [];
  const queues = new Map<string, Responder[]>();
  for (const [key, value] of Object.entries(routes)) queues.set(key, Array.isArray(value) ? [...value] : [value]);
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.startsWith(`${BASE}/api/v1/`) ? url.slice(`${BASE}/api/v1/`.length) : url;
    let body: unknown = init?.body;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method, path, headers: new Headers(init?.headers), body };
    calls.push(call);
    const queue = queues.get(`${method} ${path.split('?')[0]}`);
    if (!queue || queue.length === 0) throw new Error(`unexpected request ${method} ${path}`);
    const responder = queue.length > 1 ? (queue.shift() as Responder) : queue[0];
    return responder(call);
  });
  return { fetchImpl, calls };
}

function openResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    patientId: 'p1',
    doctorId: 'd1',
    appointmentDate: '2026-10-05',
    status: 'OPEN',
    processing: 'IDLE',
    visitType: 'new-visit',
    externalRef: 'ref-1',
    recordable: true,
    version: 3,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    governingRun: null,
    ...overrides,
  };
}

function captureState(overrides: Record<string, unknown> = {}) {
  return {
    consultationId: 'c1',
    status: 'RECORDING',
    processing: 'IDLE',
    encounterSeq: 1,
    sessionId: 'ext-1',
    recording: true,
    paused: false,
    version: 4,
    updatedAt: '2026-10-05T00:00:01Z',
    ...overrides,
  };
}

class FakeSocket {
  connected = false;
  closed = false;
  constructor(readonly sessionId: string) {}
  async connect() {
    this.connected = true;
  }
  on() {
    return () => undefined;
  }
  sendControl() {}
  close() {
    this.closed = true;
    this.connected = false;
  }
  async waitForClosed() {
    return { requested: true, resuming: false };
  }
}

function build(routes: Record<string, Responder | Responder[]>, open: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = makeFetch(routes);
  const sleep = vi.fn(async () => undefined);
  const transport = new Transport({ baseUrl: BASE, apiKey: 'key-1', fetch: fetchImpl, sleep, random: () => 0.5, maxRetries: 0 });
  const socket = new FakeSocket('sdk-1');
  const stt = {
    createStreamSession: vi.fn(async () => ({ sessionId: 'sdk-1', ticket: 't', ticketExpiresAt: 1, wsUrl: '/ws/stt/stream' })),
    socket: vi.fn(() => socket),
  };
  const deps: ConsultationHandleDeps = { transport, stt: stt as unknown as ConsultationHandleDeps['stt'], fetch: fetchImpl, sleep };
  const handle = new ConsultationHandle(openResponse(open) as never, deps);
  return { handle, calls, stt, socket };
}

describe('handle.startCapture(sttSessionId) — bind an STT session the caller already runs', () => {
  it('POSTs :id/start {sessionId} with X-Hope-Lifecycle: 2 and opens no SDK session or socket', async () => {
    const { handle, calls, stt } = build({ 'POST consultations/c1/start': () => json(200, captureState()) });
    const states: unknown[] = [];
    handle.on('capture-state', (s) => states.push(s));

    const state = await handle.startCapture('ext-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ sessionId: 'ext-1' });
    expect(calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
    expect(stt.createStreamSession).not.toHaveBeenCalled();
    expect(stt.socket).not.toHaveBeenCalled();
    expect(state.status).toBe('RECORDING');
    expect(state.sessionId).toBe('ext-1');
    expect(handle.status).toBe('RECORDING');
    expect(handle.version).toBe(4);
    expect(states).toEqual([{ state: 'capturing', sessionId: 'ext-1' }]);
  });

  it('resumes a PAUSED consultation on the external session (the same POST, no socket frame)', async () => {
    const { handle, calls, stt } = build(
      { 'POST consultations/c1/start': () => json(200, captureState({ sessionId: 'ext-2', version: 9 })) },
      { status: 'PAUSED', version: 8 },
    );
    expect(handle.status).toBe('PAUSED');
    const state = await handle.startCapture('ext-2');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST consultations/c1/start']);
    expect(calls[0]?.body).toEqual({ sessionId: 'ext-2' });
    expect(stt.createStreamSession).not.toHaveBeenCalled();
    expect(state.paused).toBe(false);
    expect(handle.status).toBe('RECORDING');
    expect(handle.version).toBe(9);
  });

  it('a different session supersedes an SDK-owned socket: the handle closes its own', async () => {
    const { handle, socket } = build({
      'POST consultations/c1/start': [() => json(200, captureState({ sessionId: 'sdk-1' })), () => json(200, captureState({ sessionId: 'ext-3', version: 5 }))],
    });
    await handle.start();
    expect(socket.connected).toBe(true);
    await handle.startCapture('ext-3');
    expect(socket.closed).toBe(true);
  });

  it('refuses an empty session id locally, before any request', async () => {
    const { handle, calls } = build({});
    await expect(handle.startCapture('')).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the gateway 409 (e.g. STT_SESSION_NOT_ACTIVE) and keeps the tracked status', async () => {
    const { handle } = build({
      'POST consultations/c1/start': () => json(409, { statusCode: 409, code: 'STT_SESSION_NOT_ACTIVE', message: 'gone' }),
    });
    await expect(handle.startCapture('ext-x')).rejects.toMatchObject({ status: 409 });
    expect(handle.status).toBe('OPEN');
  });
});

describe('handle.refresh() — public re-read', () => {
  it('GETs the consultation with the lifecycle header, updates status/processing/version and returns the state', async () => {
    const { handle, calls } = build({
      'GET consultations/c1': () =>
        json(200, {
          ...openResponse({ status: 'COMPLETED', version: 12 }),
          lifecycle: { status: 'CLOSED_INCOMPLETE', processing: 'IDLE' },
          processingReason: null,
          closedReason: 'AUTO',
          reopenAllowed: true,
        }),
    });
    const state = await handle.refresh();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
    expect(state.id).toBe('c1');
    expect(state.status).toBe('CLOSED_INCOMPLETE');
    expect(state.processing).toBe('IDLE');
    expect(state.version).toBe(12);
    expect(state.closedReason).toBe('AUTO');
    expect(state.reopenAllowed).toBe(true);
    expect(handle.status).toBe('CLOSED_INCOMPLETE');
    expect(handle.version).toBe(12);
  });

  it('a 404 propagates (the consultation is not this caller\'s)', async () => {
    const { handle } = build({ 'GET consultations/c1': () => json(404, { statusCode: 404, message: 'Not Found' }) });
    await expect(handle.refresh()).rejects.toMatchObject({ status: 404 });
  });
});

describe('every handle verb sends X-Hope-Lifecycle: 2', () => {
  it('startCapture, refresh, pause, stop, approve, close, reopen, history, recap, feedbackReasonCodes, sendFeedback', async () => {
    const state = (o: Record<string, unknown> = {}) => json(200, { id: 'c1', status: 'STOPPED', processing: 'IDLE', version: 7, ...o });
    const { handle, calls } = build({
      'POST consultations/c1/start': () => json(200, captureState()),
      'GET consultations/c1': () => json(200, openResponse({ version: 5 })),
      'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true })),
      'POST consultations/c1/stop': () => json(200, { ...captureState({ status: 'STOPPED', recording: false }), finalTranscript: { state: 'complete' } }),
      'POST consultations/c1/approve': () => state({ status: 'APPROVED' }),
      'POST consultations/c1/close': () => state({ status: 'CLOSED_COMPLETE' }),
      'POST consultations/c1/reopen': () => state({ status: 'STOPPED' }),
      'GET consultations/c1/history': () => json(200, { items: [], hasMore: false, nextCursor: null }),
      'GET consultations/c1/encounters/1/recap': () => json(200, { encounterSeq: 1, lines: [] }),
      'GET consultations/feedback/reason-codes': () => json(200, { codes: [] }),
      'POST consultations/c1/feedback': () => json(201, { feedbackId: 'f1' }),
    });
    await handle.startCapture('ext-1');
    await handle.refresh();
    await handle.pause();
    await handle.stop();
    await handle.approve();
    await handle.close();
    await handle.reopen();
    await handle.history();
    await handle.recap(1);
    await handle.feedbackReasonCodes();
    await handle.sendFeedback({ kind: 'comment', comment: 'ok' });
    expect(calls.length).toBe(11);
    for (const call of calls) expect([call.path, call.headers.get('x-hope-lifecycle')]).toEqual([call.path, '2']);
  });
});
