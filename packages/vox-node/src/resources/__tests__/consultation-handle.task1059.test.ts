/**
 * TASK-1059 lane S — RC-11 (a heartbeat / seq-less frame never reaches `status` listeners or state) and
 * RC-13 (a network failure on the presigned PUT falls back to the gateway `/content` route; an HTTP refusal does not).
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
  body: unknown;
}
type Responder = (call: Call) => Response | Promise<Response>;

function build(routes: Record<string, Responder | Responder[]>) {
  const calls: Call[] = [];
  const queues = new Map<string, Responder[]>();
  for (const [key, value] of Object.entries(routes)) queues.set(key, Array.isArray(value) ? [...value] : [value]);
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.startsWith(`${BASE}/api/v1/`) ? url.slice(`${BASE}/api/v1/`.length) : url;
    const call: Call = { method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body };
    calls.push(call);
    const queue = queues.get(`${method} ${path.split('?')[0]}`);
    if (!queue || queue.length === 0) throw new Error(`unexpected request ${method} ${path}`);
    const responder = queue.length > 1 ? (queue.shift() as Responder) : queue[0]!;
    return responder(call);
  });
  const sleep = vi.fn(async () => undefined);
  const transport = new Transport({ baseUrl: BASE, apiKey: 'key-1', fetch: fetchImpl, sleep, random: () => 0.5, maxRetries: 0 });
  const deps = { transport, stt: {} as never, fetch: fetchImpl, sleep, random: () => 0.5 } as ConsultationHandleDeps;
  const handle = new ConsultationHandle(
    { id: 'c1', patientId: 'p1', status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 6 } as never,
    deps,
  );
  return { handle, calls };
}

describe('lifecycle events: heartbeat and seq-less frames (RC-11)', () => {
  const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
  const real = {
    type: 'processing_changed',
    consultationId: 'c1',
    status: 'STOPPED',
    processing: 'AWAITING_REVIEW',
    processingReason: 'GUARDRAIL_HOLD',
    version: 7,
    at: 't',
    seq: 1,
  };

  it('does not dispatch a heartbeat or a seq-less frame, and keeps the hold reason', async () => {
    const body = [frame({ type: 'heartbeat' }), frame({ status: 'OPEN', processing: 'IDLE' }), frame(real)].join('');
    const { handle } = build({
      // The first connection carries the frames; reconnects (instant sleep) get an empty stream so the idle cap ends them.
      'GET consultations/c1/events': [
        () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ],
      'GET consultations/c1/guardrail-notices': () => json(200, []),
    });
    const seen: Array<{ type?: string; seq?: number }> = [];
    await new Promise<void>((resolve) => {
      handle.on('status', (e) => {
        seen.push(e as never);
        setTimeout(resolve, 20);
      });
    });
    handle.dispose();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.seq).toBe(1);
    expect(handle.processingReason).toBe('GUARDRAIL_HOLD');
    expect(handle.status).toBe('STOPPED');
  });
});

describe('sendAttachment network fallback (RC-13)', () => {
  const INTENT = {
    attachmentId: 'a1',
    status: 'INTENT',
    kind: 'document',
    uploadMode: 'presigned',
    uploadUrl: 'https://store.example/obj?sig=1',
    uploadMethod: 'PUT',
    uploadHeaders: {},
    uploadExpiresAt: 'x',
    intentExpiresAt: 'y',
    maxSizeBytes: 100,
  };
  const SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const READY = { attachmentId: 'a1', status: 'READY', kind: 'document', mime: 'application/pdf', sizeBytes: 5, sha256: SHA, mediaId: 'm1', contextItemId: 'ci1' };
  const hello = () => ({ kind: 'pdf' as const, data: new TextEncoder().encode('hello'), mime: 'application/pdf', name: 'a.pdf' });

  it('falls back to the multipart /content route when the PUT fails on the network', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => {
        throw new TypeError('fetch failed');
      },
      'POST consultations/c1/attachments/a1/content': () => json(200, READY),
    });
    const result = await handle.sendAttachment(hello());
    const content = calls.find((c) => c.path.endsWith('/content'));
    expect(content?.body).toBeInstanceOf(FormData);
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
    expect(result.attachmentId).toBe('a1');
  });

  it('does not fall back on an HTTP 403 from storage', async () => {
    const { handle, calls } = build({
      'POST consultations/c1/attachments': () => json(201, INTENT),
      'PUT https://store.example/obj': () => new Response('<Error/>', { status: 403 }),
    });
    await expect(handle.sendAttachment(hello())).rejects.toThrow(/403/);
    expect(calls.some((c) => c.path.endsWith('/content'))).toBe(false);
  });
});
