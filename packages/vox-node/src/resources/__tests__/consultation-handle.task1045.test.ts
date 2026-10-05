import { describe, expect, it, vi } from 'vitest';

import { VersionConflictError } from '../../core/errors';
import { Transport } from '../../core/transport';
import { ConsultationHandle, type ConsultationHandleDeps } from '../consultation-handle';
import { ConsultationsResource } from '../consultations';

const BASE = 'http://localhost:8868';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: unknown;
  init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;

/** A fetch whose responses are queued per `METHOD path` (path relative to `/api/v1/`, or the full URL for non-gateway hosts). */
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
    const call: Call = { method, path, url, headers: new Headers(init?.headers), body, init: init ?? {} };
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
    sessionId: 's1',
    recording: true,
    paused: false,
    version: 4,
    updatedAt: '2026-10-05T00:00:01Z',
    ...overrides,
  };
}

class FakeSocket {
  connected = false;
  sessionId: string;
  controls: unknown[] = [];
  closed = false;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  constructor(
    sessionId = 's1',
    private readonly log: string[] = [],
  ) {
    this.sessionId = sessionId;
  }
  async connect() {
    this.log.push('socket.connect');
    this.connected = true;
  }
  on(event: string, listener: (p: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((l) => l(payload));
  }
  sendControl(frame: unknown) {
    this.controls.push(frame);
  }
  close() {
    this.closed = true;
    this.connected = false;
  }
  async waitForClosed() {
    return { requested: true, resuming: false };
  }
}

function build(routes: Record<string, Responder | Responder[]>, opts: { open?: Record<string, unknown>; socket?: FakeSocket; log?: string[] } = {}) {
  const { fetchImpl, calls } = makeFetch(routes);
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  const transport = new Transport({ baseUrl: BASE, apiKey: 'key-1', fetch: fetchImpl, sleep, random: () => 0.5, maxRetries: 2 });
  const log = opts.log ?? [];
  const socket = opts.socket ?? new FakeSocket('s1', log);
  const stt = {
    createStreamSession: vi.fn(async (req: unknown) => {
      log.push('stt.createStreamSession');
      return { sessionId: 's1', ticket: 't', ticketExpiresAt: 1, wsUrl: '/ws/stt/stream', req };
    }),
    socket: vi.fn(() => {
      log.push('stt.socket');
      return socket;
    }),
  };
  const deps: ConsultationHandleDeps = {
    transport,
    stt: stt as unknown as ConsultationHandleDeps['stt'],
    fetch: fetchImpl,
    sleep,
    random: () => 0.5,
  };
  const handle = new ConsultationHandle(openResponse(opts.open) as never, deps);
  return { handle, calls, fetchImpl, socket, stt, sleeps, log, transport };
}

describe('consultation handle: open / attach / header', () => {
  it('open() returns a handle exposing every open-response field and sends X-Hope-Lifecycle: 2', async () => {
    const { fetchImpl, calls } = makeFetch({ 'POST consultations/open': () => json(200, openResponse()) });
    const resource = new ConsultationsResource(new Transport({ baseUrl: BASE, fetch: fetchImpl }));
    const handle = await resource.open({ patientId: 'p1' });
    expect(handle).toBeInstanceOf(ConsultationHandle);
    expect(handle.id).toBe('c1');
    expect(handle.externalRef).toBe('ref-1');
    expect(handle.recordable).toBe(true);
    expect(handle.status).toBe('OPEN');
    expect(calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
  });

  it('attach(id) reads the consultation and returns a handle; plain reads carry the header too', async () => {
    const { fetchImpl, calls } = makeFetch({ 'GET consultations/c9': () => json(200, openResponse({ id: 'c9', status: 'PAUSED' })) });
    const resource = new ConsultationsResource(new Transport({ baseUrl: BASE, fetch: fetchImpl }));
    const handle = await resource.attach('c9');
    expect(handle.id).toBe('c9');
    expect(handle.status).toBe('PAUSED');
    expect(calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
  });

  it('every handle call sends the lifecycle header', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true })) });
    await handle.pause();
    expect(calls.every((c) => c.headers.get('x-hope-lifecycle') === '2')).toBe(true);
  });

  it('prefers the lifecycle block over the projected status', () => {
    const { handle } = build({}, { open: { status: 'RECORDING', lifecycle: { status: 'PAUSED', processing: 'IDLE' } } });
    expect(handle.status).toBe('PAUSED');
  });
});

describe('start / pause / stop', () => {
  it('start composes session -> POST :id/start {sessionId} -> socket -> connect', async () => {
    const log: string[] = [];
    const { handle, calls, stt } = build(
      {
        'POST consultations/c1/start': (c) => {
          log.push('POST start');
          return json(200, captureState());
        },
      },
      { log },
    );
    const capture = await handle.start({ agentSlug: 'asr-a', language: 'ml-en' });
    expect(stt.createStreamSession).toHaveBeenCalledWith({ consultationId: 'c1', agentSlug: 'asr-a', language: 'ml-en' }, expect.anything());
    expect(calls.find((c) => c.path === 'consultations/c1/start')?.body).toEqual({ sessionId: 's1' });
    expect(log).toEqual(['stt.createStreamSession', 'POST start', 'stt.socket', 'socket.connect']);
    expect(capture.sessionId).toBe('s1');
    expect(capture.resumed).toBe(false);
    expect(handle.status).toBe('RECORDING');
    expect(handle.version).toBe(4);
  });

  it('pause POSTs :id/pause and sends the pause frame on a live socket', async () => {
    const { handle, socket } = build({
      'POST consultations/c1/start': () => json(200, captureState()),
      'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true })),
    });
    await handle.start();
    const state = await handle.pause();
    expect(state.paused).toBe(true);
    expect(socket.controls).toEqual([{ type: 'pause' }]);
    expect(handle.status).toBe('PAUSED');
  });

  it('pause without a socket only POSTs', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true })) });
    await handle.pause();
    expect(calls).toHaveLength(1);
  });

  it('start on a PAUSED consultation with a live socket resumes via resume-capture, no new session', async () => {
    const { handle, socket, stt } = build({
      'POST consultations/c1/start': [() => json(200, captureState()), () => json(200, captureState({ version: 6 }))],
      'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true, version: 5 })),
    });
    await handle.start();
    await handle.pause();
    stt.createStreamSession.mockClear();
    const capture = await handle.start();
    expect(stt.createStreamSession).not.toHaveBeenCalled();
    expect(socket.controls).toEqual([{ type: 'pause' }, { type: 'resume-capture' }]);
    expect(capture.resumed).toBe(true);
    expect(handle.status).toBe('RECORDING');
  });

  it('start on PAUSED with a dropped socket re-handshakes the same session', async () => {
    const { handle, socket, stt } = build({
      'POST consultations/c1/start': [() => json(200, captureState()), () => json(200, captureState({ version: 6 }))],
      'POST consultations/c1/pause': () => json(200, captureState({ status: 'PAUSED', paused: true })),
    });
    await handle.start();
    await handle.pause();
    socket.connected = false;
    stt.createStreamSession.mockClear();
    const capture = await handle.start();
    expect(stt.createStreamSession).not.toHaveBeenCalled();
    expect(socket.connected).toBe(true);
    expect(socket.controls).not.toContainEqual({ type: 'resume-capture' });
    expect(capture.resumed).toBe(true);
  });

  it('stop waits for the final transcript, returns it and closes the socket', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { handle, calls, socket } = build({
      'POST consultations/c1/start': () => json(200, captureState()),
      'POST consultations/c1/stop': async () => {
        await gate;
        return json(200, {
          ...captureState({ status: 'STOPPED', processing: 'SUMMARIZING', recording: false }),
          finalTranscript: { state: 'complete', contextItemId: 'ft1', versionNumber: 2, segmentCount: 9, lastSegmentSeq: 9 },
        });
      },
    });
    await handle.start();
    let settled = false;
    const pending = handle.stop().then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const result = await pending;
    expect(calls.find((c) => c.path === 'consultations/c1/stop')?.body).toMatchObject({ waitForFinal: true });
    expect(result.finalTranscript.contextItemId).toBe('ft1');
    expect(socket.closed).toBe(true);
    expect(handle.status).toBe('STOPPED');
    expect(handle.processing).toBe('SUMMARIZING');
  });
});

describe('approve / close / reopen (If-Match)', () => {
  it('approve sends If-Match from the handle version and updates it', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/approve': () => json(200, openResponse({ status: 'APPROVED', version: 8 })) });
    const state = await handle.approve({ clinicianUserId: 'd1' });
    const call = calls[0];
    expect(call?.headers.get('if-match')).toBe('"3"');
    expect(call?.body).toEqual({ clinicianUserId: 'd1' });
    expect(state.status).toBe('APPROVED');
    expect(handle.version).toBe(8);
  });

  it('refetches the version once on a 412 and retries with it', async () => {
    const conflict = () => json(412, { message: 'stale', metadata: { currentVersion: 5 } });
    const { handle, calls } = build({
      'POST consultations/c1/close': [conflict, () => json(200, openResponse({ status: 'CLOSED_COMPLETE', version: 6 }))],
      'GET consultations/c1': () => json(200, openResponse({ version: 5 })),
    });
    const state = await handle.close();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.headers.get('if-match'))).toEqual(['"3"', '"5"']);
    expect(state.status).toBe('CLOSED_COMPLETE');
  });

  it('does not loop: a second 412 surfaces', async () => {
    const conflict = () => json(412, { message: 'stale' });
    const { handle, calls } = build({
      'POST consultations/c1/reopen': conflict,
      'GET consultations/c1': () => json(200, openResponse({ version: 5 })),
    });
    await expect(handle.reopen({ reason: 'late addendum' })).rejects.toBeInstanceOf(VersionConflictError);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
});

describe('generateSummary', () => {
  it('sends outputLanguage and sectionKeys and returns the job without waiting by default', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/summary/async': () => json(200, { jobId: 'j1', status: 'pending', consultationId: 'c1', createdAt: 'x' }),
    });
    const job = await handle.generateSummary({ outputLanguage: 'en', sectionKeys: ['plan'] });
    expect(calls[0]?.body).toMatchObject({ outputLanguage: 'en', sectionKeys: ['plan'] });
    expect(job.jobId).toBe('j1');
  });

  it('wait: true polls the job to completion and returns the latest note', async () => {
    const { handle } = build({
      'POST consultations/c1/summary/async': () => json(200, { jobId: 'j1', status: 'pending', consultationId: 'c1', createdAt: 'x' }),
      'GET consultations/jobs/j1/stream': () => new Response('', { status: 404 }),
      'GET consultations/jobs/j1': [
        () => json(200, { jobId: 'j1', status: 'RUNNING' }),
        () => json(200, { jobId: 'j1', status: 'COMPLETED' }),
      ],
      'GET consultations/c1/summary/latest': () => json(200, { id: 'n1', content: 'note' }),
    });
    const result = await handle.generateSummary({ wait: true, pollIntervalMs: 1 });
    expect(result.status).toBe('completed');
    expect(result.summary).toMatchObject({ id: 'n1' });
  });
});

const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const INTENT = {
  attachmentId: 'a1',
  status: 'INTENT',
  kind: 'document',
  uploadMode: 'presigned',
  uploadUrl: 'https://store.example/obj?sig=1',
  uploadMethod: 'PUT',
  uploadHeaders: { 'Content-Type': 'application/pdf', 'Content-Length': '5' },
  uploadExpiresAt: 'x',
  intentExpiresAt: 'y',
  maxSizeBytes: 100,
};
const READY = { attachmentId: 'a1', status: 'READY', kind: 'document', mime: 'application/pdf', sizeBytes: 5, sha256: HELLO_SHA, mediaId: 'm1', contextItemId: 'ci1' };
const hello = () => ({ kind: 'pdf' as const, data: new TextEncoder().encode('hello'), mime: 'application/pdf', name: 'a.pdf' });

describe('sendAttachment', () => {
  it('hashes, creates the intent, PUTs without credentials, then completes', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => new Response(null, { status: 200 }),
      'POST consultations/c1/attachments/a1/complete': () => json(200, READY),
    });
    const phases: string[] = [];
    const result = await handle.sendAttachment(hello(), { onProgress: (p) => phases.push(p) });
    const intent = calls[0];
    expect(intent?.body).toMatchObject({ kind: 'document', mime: 'application/pdf', sizeBytes: 5, sha256: HELLO_SHA, fileName: 'a.pdf' });
    expect(intent?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.headers.get('x-api-key')).toBeNull();
    expect(put?.headers.get('authorization')).toBeNull();
    expect(put?.headers.get('x-hope-lifecycle')).toBeNull();
    expect(put?.headers.get('content-type')).toBe('application/pdf');
    expect(result.status).toBe('READY');
    expect(result.contextItemId).toBe('ci1');
    expect(phases).toEqual(['hashing', 'intent', 'uploading', 'completing', 'ready']);
  });

  it('polls GET :id/attachments/:aid when complete answers 202 until READY', async () => {
    const { handle } = build({
      'POST consultations/c1/attachments': () => json(201, { ...INTENT, kind: 'audio' }),
      'PUT https://store.example/obj': () => new Response(null, { status: 200 }),
      'POST consultations/c1/attachments/a1/complete': () => json(202, { ...READY, status: 'PROCESSING', transcriptionJobId: 'tj' }),
      'GET consultations/c1/attachments/a1': [() => json(200, { ...READY, status: 'PROCESSING' }), () => json(200, READY)],
    });
    const result = await handle.sendAttachment({ ...hello(), kind: 'audio', mime: 'audio/ogg' }, { pollIntervalMs: 1 });
    expect(result.status).toBe('READY');
  });

  it('a polled FAILED attachment throws', async () => {
    const { handle } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => new Response(null, { status: 200 }),
      'POST consultations/c1/attachments/a1/complete': () => json(202, { ...READY, status: 'PROCESSING' }),
      'GET consultations/c1/attachments/a1': () => json(200, { ...READY, status: 'FAILED', failureCode: 'ATTACHMENT_CONTENT_MISMATCH' }),
    });
    await expect(handle.sendAttachment(hello(), { pollIntervalMs: 1 })).rejects.toThrow(/ATTACHMENT_CONTENT_MISMATCH/);
  });

  it('uses the multipart /content route when uploadUrl is null', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, { ...INTENT, uploadUrl: null }),
      'POST consultations/c1/attachments/a1/content': () => json(200, READY),
    });
    const result = await handle.sendAttachment(hello());
    const content = calls.find((c) => c.path.endsWith('/content'));
    expect(content?.body).toBeInstanceOf(FormData);
    expect((content?.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(result.attachmentId).toBe('a1');
  });

  it('retries the intent on 503 with the SAME Idempotency-Key', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': [() => json(503, { message: 'busy' }), () => json(201, INTENT)],
      'PUT https://store.example/obj': () => new Response(null, { status: 200 }),
      'POST consultations/c1/attachments/a1/complete': () => json(200, READY),
    });
    await handle.sendAttachment(hello());
    const intents = calls.filter((c) => c.path === 'consultations/c1/attachments');
    expect(intents).toHaveLength(2);
    expect(intents[0]?.headers.get('idempotency-key')).toBe(intents[1]?.headers.get('idempotency-key'));
  });

  it('retries the PUT on 5xx, 429 (honouring Retry-After) and network errors', async () => {
    const { handle, calls, sleeps } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': [
        () => new Response(null, { status: 503 }),
        () => new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
        () => {
          throw new TypeError('fetch failed');
        },
        () => new Response(null, { status: 200 }),
      ],
      'POST consultations/c1/attachments/a1/complete': () => json(200, READY),
    });
    await handle.sendAttachment(hello());
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(4);
    expect(sleeps).toContain(2000);
  });

  it('never retries another 4xx on the PUT', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => new Response('<Error/>', { status: 403 }),
    });
    await expect(handle.sendAttachment(hello())).rejects.toThrow(/403/);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('never retries a 4xx on the intent', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/attachments': () => json(422, { message: 'kind', code: 'ATTACHMENT_KIND_UNSUPPORTED' }) });
    await expect(handle.sendAttachment({ ...hello(), kind: 'image', mime: 'image/png' })).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});

describe('sendFeedback', () => {
  const FB = { id: 'f1', consultationId: 'c1', target: null, rating: 'up', reasonCodes: [], comment: null, attachmentIds: [], correction: null, isLatest: true, createdAt: 'x' };

  it('rating needs a target (local TypeError, no request)', async () => {
    const { handle, calls } = build({});
    await expect(handle.sendFeedback({ kind: 'rating', rating: 'up' } as never)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('rating / comment / edit map onto the feedback body with an Idempotency-Key', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/feedback': () => json(201, FB) });
    const target = { kind: 'SECTION' as const, contextItemId: 'n1', versionNumber: 2, sectionKey: 'plan' };
    await handle.sendFeedback({ kind: 'rating', target, rating: 'down', reasonCodes: ['too_long'], comment: 'wordy' });
    await handle.sendFeedback({ kind: 'comment', comment: 'overall fine' });
    await handle.sendFeedback({ kind: 'edit', target, content: 'new plan', expectedVersion: 2 });
    expect(calls[0]?.body).toMatchObject({ target, rating: 'down', reasonCodes: ['too_long'], comment: 'wordy' });
    expect(calls[1]?.body).toEqual({ comment: 'overall fine' });
    expect(calls[2]?.body).toMatchObject({ target, correction: { content: 'new plan', expectedVersion: 2 } });
    for (const c of calls) expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(calls[0]?.headers.get('idempotency-key')).not.toBe(calls[1]?.headers.get('idempotency-key'));
  });

  it('uploads feedback evidence first with purpose=feedback and links the attachment ids', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => new Response(null, { status: 200 }),
      'POST consultations/c1/attachments/a1/complete': () => json(200, READY),
      'POST consultations/c1/feedback': () => json(201, FB),
    });
    await handle.sendFeedback({ kind: 'comment', comment: 'see photo', attachments: [{ ...hello(), kind: 'image', mime: 'image/png' }] });
    expect(calls[0]?.body).toMatchObject({ purpose: 'feedback' });
    expect(calls[calls.length - 1]?.body).toMatchObject({ attachmentIds: ['a1'] });
  });
});

describe('history / recap', () => {
  const entry = (id: string) => ({ entryType: 'item', id, kind: 'NOTE' });
  it('history passes filters; historyAll walks the cursor to the end', async () => {
    const { handle, calls } = build({
      'GET consultations/c1/history': [
        () => json(200, { consultationId: 'c1', items: [entry('a'), entry('b')], nextCursor: 'cur1', hasMore: true, encounters: [] }),
        () => json(200, { consultationId: 'c1', items: [entry('c')], nextCursor: null, hasMore: false, encounters: [] }),
      ],
    });
    const ids: string[] = [];
    for await (const item of handle.historyAll({ kinds: ['NOTE', 'FEEDBACK'], limit: 2 })) ids.push((item as { id: string }).id);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(calls[0]?.path).toContain('kinds=NOTE%2CFEEDBACK');
    expect(calls[1]?.path).toContain('cursor=cur1');
  });

  it('history returns one page', async () => {
    const { handle } = build({ 'GET consultations/c1/history': () => json(200, { consultationId: 'c1', items: [], nextCursor: null, hasMore: false, encounters: [] }) });
    const page = await handle.history();
    expect(page.hasMore).toBe(false);
  });

  it('recap(seq) reads the encounter recap', async () => {
    const { handle, calls } = build({ 'GET consultations/c1/encounters/2/recap': () => json(200, { encounterSeq: 2, text: 'recap' }) });
    expect((await handle.recap(2)).text).toBe('recap');
    expect(calls[0]?.path).toBe('consultations/c1/encounters/2/recap');
  });
});

describe('events', () => {
  it("on('status') is fed by the lifecycle SSE stream parsed off the response body", async () => {
    const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
    const events = [
      { type: 'started', consultationId: 'c1', status: 'RECORDING', processing: 'IDLE', version: 4, at: 't', seq: 1 },
      { type: 'stopped', consultationId: 'c1', status: 'STOPPED', processing: 'FINALIZING_TRANSCRIPT', version: 5, at: 't', seq: 2 },
    ];
    const { handle, calls } = build({
      'GET consultations/c1/events': () => new Response(events.map(frame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const seen: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      handle.on('status', (e) => {
        seen.push(e);
        if (seen.length === 2) resolve();
      });
    });
    await done;
    handle.dispose();
    expect(seen).toEqual(events);
    expect(calls[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
    expect(handle.status).toBe('STOPPED');
  });

  it("forwards socket transcripts and capture-state frames; on() returns an unsubscribe", async () => {
    const { handle, socket } = build({ 'POST consultations/c1/start': () => json(200, captureState()) });
    const transcripts: unknown[] = [];
    const states: unknown[] = [];
    const off = handle.on('transcript', (t) => transcripts.push(t));
    handle.on('capture-state', (s) => states.push(s));
    await handle.start();
    socket.emit('transcript', { text: 'hi' });
    socket.emit('status', { type: 'status', status: 'paused' });
    off();
    socket.emit('transcript', { text: 'ignored' });
    expect(transcripts).toEqual([{ text: 'hi' }]);
    expect(states).toContainEqual(expect.objectContaining({ state: 'paused' }));
  });
});
