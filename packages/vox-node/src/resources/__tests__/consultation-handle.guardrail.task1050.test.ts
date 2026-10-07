/**
 * TASK-1050 W2d — the consultation handle's guardrail surface: notices read, acknowledge and resume send `If-Match`
 * (the version last seen, one re-read on a 412), approve carries the acknowledge/resolve additions and returns
 * `acknowledgedNotices`, and `on('guardrail-notice')` delivers each notice once when a lifecycle event reports a hold.
 */

import { describe, expect, it, vi } from 'vitest';
import { Transport } from '../../core/transport';
import { ConsultationHandle, type ConsultationHandleDeps } from '../consultation-handle';

const BASE = 'http://localhost:8868';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    const path = url.slice(`${BASE}/api/v1/`.length);
    const call: Call = { method, path, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const queue = queues.get(`${method} ${path.split('?')[0]}`);
    if (!queue || queue.length === 0) throw new Error(`unexpected request ${method} ${path}`);
    const responder = queue.length > 1 ? (queue.shift() as Responder) : queue[0]!;
    return responder(call);
  });
  return { fetchImpl, calls };
}

const NOTICE = (id: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  noticeId: id,
  type: 'guardrail.blocked',
  direction: 'inbound',
  action: 'block',
  checks: [{ checkId: 'injection_judge', severity: 'high' }],
  consultationId: 'c1',
  itemIds: ['i1'],
  messageKey: 'guardrail.blocked.inbound',
  defaultMessage: 'A safety check stopped this request. Review the flagged input to continue.',
  requiresAcknowledgement: false,
  resumable: true,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-07T09:15:00.000Z',
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({ id: 'c1', status: 'PAUSED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 7, ...over });

function build(routes: Record<string, Responder | Responder[]>, open: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = makeFetch(routes);
  const sleep = vi.fn(async () => undefined);
  const transport = new Transport({ baseUrl: BASE, apiKey: 'key-1', fetch: fetchImpl, sleep, random: () => 0.5, maxRetries: 0 });
  const deps = { transport, stt: {} as never, fetch: fetchImpl, sleep, random: () => 0.5 } as ConsultationHandleDeps;
  const handle = new ConsultationHandle(
    { id: 'c1', patientId: 'p1', status: 'PAUSED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 6, ...open } as never,
    deps,
  );
  return { handle, calls };
}

describe('guardrail notices', () => {
  it('guardrailNotices() reads the list (bare array or { notices })', async () => {
    const a = build({ 'GET consultations/c1/guardrail-notices': () => json(200, [NOTICE('n1')]) });
    expect((await a.handle.guardrailNotices()).map((n) => n.noticeId)).toEqual(['n1']);
    const b = build({ 'GET consultations/c1/guardrail-notices': () => json(200, { notices: [NOTICE('n2')], unacknowledgedNoticeIds: ['n2'] }) });
    expect((await b.handle.guardrailNotices()).map((n) => n.noticeId)).toEqual(['n2']);
    expect(a.calls[0]?.headers.get('x-hope-lifecycle')).toBe('2');
  });

  it('acknowledgeNotice POSTs the ack route with the version last seen as a strong If-Match', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/guardrail-notices/n%2F1/ack': () => json(200, state({ status: 'STOPPED', processing: 'IDLE', processingReason: null, version: 7 })) });
    await handle.acknowledgeNotice('n/1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('if-match')).toBe('"6"');
    expect(handle.version).toBe(7);
  });

  it('resumeHold POSTs { noticeId, resolution } with If-Match and follows the answer', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/guardrail-hold/resume': () => json(200, state({ status: 'STOPPED', processing: 'SUMMARIZING', processingReason: null, version: 8 })),
    });
    expect(handle.onGuardrailHold).toBe(true);
    await handle.resumeHold({ noticeId: 'n1', resolution: 'item_excluded' });
    expect(calls[0]?.body).toEqual({ noticeId: 'n1', resolution: 'item_excluded' });
    expect(calls[0]?.headers.get('if-match')).toBe('"6"');
    expect(handle.processing).toBe('SUMMARIZING');
    expect(handle.version).toBe(8);
    expect(handle.onGuardrailHold).toBe(false);
  });

  it('on a 412 it re-reads once and retries with the fresh version (the existing OCC pattern)', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/guardrail-hold/resume': [
        () => json(412, { code: 'PERSISTENCE.CONCURRENCY_CONFLICT', metadata: { currentVersion: 9 } }),
        () => json(200, state({ version: 10, processing: 'IDLE', processingReason: null })),
      ],
      'GET consultations/c1': () => json(200, state({ version: 9 })),
    });
    await handle.resumeHold({ noticeId: 'n1', resolution: 'acknowledged' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.headers.get('if-match'))).toEqual(['"6"', '"9"']);
  });

  it('an explicit ifMatch is sent as given and never retried', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/guardrail-hold/resume': () => json(200, state({ version: 12 })) });
    await handle.resumeHold({ noticeId: 'n1', resolution: 'item_edited' }, { ifMatch: 11 });
    expect(calls[0]?.headers.get('if-match')).toBe('"11"');
  });
});

describe('approve — one call with acknowledge and resolveHold', () => {
  it('sends the additions and returns acknowledgedNotices', async () => {
    const acknowledged = [{ noticeId: 'n1', acknowledgedBy: 'u1', acknowledgedVia: 'approve', acknowledgedAt: '2026-10-07T09:20:00.000Z' }];
    const { handle, calls } = build({
      'POST consultations/c1/approve': () => json(200, { ...state({ status: 'APPROVED', processing: 'IDLE', processingReason: null, version: 8 }), acknowledgedNotices: acknowledged }),
    });
    const result = await handle.approve({ acknowledgeGuardrailNotices: true, resolveHold: { noticeId: 'n1', resolution: 'item_excluded' } });
    expect(calls[0]?.body).toEqual({ acknowledgeGuardrailNotices: true, resolveHold: { noticeId: 'n1', resolution: 'item_excluded' } });
    expect(calls[0]?.headers.get('if-match')).toBe('"6"');
    expect(result.acknowledgedNotices).toEqual(acknowledged);
    expect(handle.status).toBe('APPROVED');
  });

  it('a plain approve body is unchanged', async () => {
    const { handle, calls } = build({ 'POST consultations/c1/approve': () => json(200, state({ status: 'APPROVED', processing: 'IDLE', version: 8 })) });
    await handle.approve({ clinicianUserId: 'u1' });
    expect(calls[0]?.body).toEqual({ clinicianUserId: 'u1' });
  });
});

describe("on('guardrail-notice') and the hold reason on status events", () => {
  const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
  const event = (seq: number, reason: string | undefined, over: Record<string, unknown> = {}) => ({
    type: 'processing_changed',
    consultationId: 'c1',
    status: 'PAUSED',
    processing: 'AWAITING_REVIEW',
    ...(reason === undefined ? {} : { processingReason: reason }),
    version: 6 + seq,
    at: 't',
    seq,
    ...over,
  });

  it('reads the notices when a status event reports a hold, delivers each noticeId once, and shows the reason', async () => {
    const events = [event(1, 'GUARDRAIL_HOLD'), event(2, 'GUARDRAIL_HOLD')];
    const { handle, calls } = build({
      'GET consultations/c1/events': () => new Response(events.map(frame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      'GET consultations/c1/guardrail-notices': () => json(200, [NOTICE('n1'), NOTICE('n2')]),
    });
    const statuses: Array<string | undefined> = [];
    const notices: string[] = [];
    const done = new Promise<void>((resolve) => {
      handle.on('status', (e) => statuses.push(e.processingReason));
      handle.on('guardrail-notice', (n) => {
        notices.push(n.noticeId);
        if (notices.length === 2) setTimeout(resolve, 20);
      });
    });
    await done;
    handle.dispose();
    expect(statuses).toEqual(['GUARDRAIL_HOLD', 'GUARDRAIL_HOLD']);
    expect(notices).toEqual(['n1', 'n2']);
    expect(handle.processingReason).toBe('GUARDRAIL_HOLD');
    expect(calls.filter((c) => c.path === 'consultations/c1/guardrail-notices').length).toBeGreaterThanOrEqual(1);
  });

  it('a status event with no hold reason reads no notices', async () => {
    const { handle, calls } = build({
      'GET consultations/c1/events': () => new Response(frame(event(1, 'NOTE_READY', { status: 'STOPPED', processing: 'IDLE' })), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    await new Promise<void>((resolve) => handle.on('status', () => setTimeout(resolve, 20)));
    handle.dispose();
    expect(calls.some((c) => c.path.endsWith('guardrail-notices'))).toBe(false);
  });

  it('a failed notice read surfaces on the error event, not as an unhandled rejection', async () => {
    const { handle } = build({
      'GET consultations/c1/events': () => new Response(frame(event(1, 'EGRESS_REDACTION_UNAVAILABLE')), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      'GET consultations/c1/guardrail-notices': () => json(500, { message: 'boom' }),
    });
    const error = await new Promise<unknown>((resolve) => {
      handle.on('guardrail-notice', () => undefined);
      handle.on('error', resolve);
    });
    handle.dispose();
    expect(error).toBeDefined();
  });
});
