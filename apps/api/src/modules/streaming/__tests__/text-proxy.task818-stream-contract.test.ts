import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextProxyController } from '../text-proxy.controller';

/**
 * the gateway is a STATELESS RELAY over a generation the
 * router owns.
 *
 * Four properties, and the third is the one that matters most: a browser that
 * hangs up must not cancel the generation. Get that backwards and every
 * resumability guarantee Lane B built is silently destroyed — the failure is
 * invisible from the gateway, because the socket closes cleanly either way.
 */

function sseFrame(event: string, data: unknown, id: string): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;
}

/** A fake express response recording every byte written to the client. */
function makeResponse() {
  const written: string[] = [];
  const res = new EventEmitter() as unknown as {
    setHeader: ReturnType<typeof vi.fn>;
    flushHeaders: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    writableEnded: boolean;
    headersSent: boolean;
    headers: Record<string, string>;
    written: string[];
    on: EventEmitter['on'];
    emit: EventEmitter['emit'];
  };
  res.headers = {};
  res.written = written;
  res.setHeader = vi.fn((k: string, v: string) => {
    res.headers[k] = v;
  });
  res.flushHeaders = vi.fn();
  res.write = vi.fn((chunk: Buffer | string) => {
    written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
  res.end = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn();
  res.writableEnded = false;
  res.headersSent = true;
  return res;
}

/** An upstream SSE body: an EventEmitter that also records its own teardown. */
function makeUpstream() {
  const upstream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  upstream.destroy = vi.fn();
  return upstream;
}

function build(upstream = makeUpstream()) {
  const http = {
    axiosRef: {
      // Params are declared (and required) so `mock.calls[0]` destructures to a
      // typed tuple — the assertions below read the forwarded URL and headers.
      get: vi.fn(async (_url: string, _options: { headers: Record<string, string | undefined> }) => ({ data: upstream })),
      post: vi.fn(),
    },
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };
  const config = { getConfigValue: vi.fn(() => 'http://text') };

  const ctrl = new TextProxyController(
    http as never,
    { fetchByCodeName: vi.fn() } as never,
    cls as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { getObject: vi.fn() } as never,
    config as never,
    undefined, // secretsService
    undefined, // harnessPolicyService
    undefined, // aiModelService
    undefined, // aiTaskDefaultService
    undefined, // aiRuntimeProfileService
    undefined, // aiProviderConnectionService
    { recordUsage: vi.fn().mockResolvedValue({ outboxIds: [], events: 0 }) } as never,
  );

  return { ctrl, upstream, http };
}

/** Let queued emitter callbacks flush into the handler. */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * An upstream whose frames are emitted as soon as something subscribes — so a
 * test never races the handler's own listener attachment, and never leaves the
 * relay's 15 s heartbeat running past the assertion.
 */
function streamOf(frames: string[], { end = true } = {}) {
  const stream = makeUpstream();
  stream.on('newListener', (event) => {
    if (event !== 'data') return;
    setImmediate(() => {
      for (const frame of frames) stream.emit('data', Buffer.from(frame));
      if (end) stream.emit('end');
    });
  });
  return stream;
}

describe('(6) — the gateway relays, it does not own', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('cursor forwarding (Last-Event-ID)', () => {
    it('forwards Last-Event-ID UPSTREAM as the canonical header', async () => {
      const { ctrl, http, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', 'gen-7:41', res as never);
      upstream.emit('end');

      const [, options] = http.axiosRef.get.mock.calls[0];
      expect(options.headers['Last-Event-ID']).toBe('gen-7:41');
    });

    it('also carries the cursor in the query, so a stripped header cannot silently restart at 0', async () => {
      const { ctrl, http, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', 'gen-7:41', res as never);
      upstream.emit('end');

      const [url] = http.axiosRef.get.mock.calls[0];
      expect(url).toContain('last_event_id=gen-7%3A41');
    });

    it('sends no cursor at all when the client has none (a fresh subscribe, not a resume from 0)', async () => {
      const { ctrl, http, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', undefined, res as never);
      upstream.emit('end');

      const [url, options] = http.axiosRef.get.mock.calls[0];
      expect(url).not.toContain('last_event_id');
      expect(options.headers['Last-Event-ID']).toBeUndefined();
    });

    it('sets the SSE hop headers the spec requires', async () => {
      const { ctrl, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', undefined, res as never);
      upstream.emit('end');

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toContain('no-cache');
      expect(res.headers['Connection']).toBe('keep-alive');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
    });
  });

  describe('id: reaches the browser unchanged', () => {
    it('relays every byte verbatim, event ids included', async () => {
      const { ctrl, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', undefined, res as never);

      const frames = [sseFrame('meta', { generation_id: 'gen-7' }, 'gen-7:0'), sseFrame('chunk', { type: 'chunk', content: 'Pat' }, 'gen-7:1')];
      for (const frame of frames) upstream.emit('data', Buffer.from(frame));
      upstream.emit('end');
      await tick();

      // A byte pipe: the client sees exactly the upstream bytes. Rewriting an
      // `id:` would hand the browser a cursor the router cannot resolve.
      expect(res.written.join('')).toContain('id: gen-7:0');
      expect(res.written.join('')).toContain('id: gen-7:1');
      expect(res.written.join('')).toBe(frames.join(''));
    });

    it('does not re-frame an id split across two upstream chunks', async () => {
      const { ctrl, upstream } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', undefined, res as never);

      const frame = sseFrame('chunk', { type: 'chunk', content: 'hi' }, 'gen-7:12');
      const split = frame.indexOf('id:') + 4;
      upstream.emit('data', Buffer.from(frame.slice(0, split)));
      upstream.emit('data', Buffer.from(frame.slice(split)));
      upstream.emit('end');
      await tick();

      expect(res.written.join('')).toBe(frame);
    });
  });

  describe('a browser disconnect is NOT a cancel', () => {
    it('drops only the gateway subscription — it never calls the router cancel route', async () => {
      const { ctrl, upstream, http } = build();
      const res = makeResponse();

      await ctrl.streamTaskEvents('gen-7', undefined, res as never);
      upstream.emit('data', Buffer.from(sseFrame('chunk', { type: 'chunk', content: 'Pat' }, 'gen-7:1')));
      await tick();

      // The browser hangs up mid-generation.
      res.writableEnded = true;
      res.emit('close');
      await tick();

      // Our own upstream subscription is dropped …
      expect(upstream.destroy).toHaveBeenCalledTimes(1);
      // … and NOTHING is POSTed. Cancellation is an explicit persisted flag,
      // never a socket event: a dropped socket is exactly the case Lane B's
      // replay buffer exists to survive.
      expect(http.axiosRef.post).not.toHaveBeenCalled();
    });

    it('holds no per-stream state, so a second subscribe is served entirely from the cursor', async () => {
      // First subscription dies after seq 1.
      const first = build();
      const resA = makeResponse();
      await first.ctrl.streamTaskEvents('gen-7', undefined, resA as never);
      first.upstream.emit('data', Buffer.from(sseFrame('chunk', { type: 'chunk', content: 'Pat' }, 'gen-7:1')));
      await tick();
      resA.writableEnded = true;
      resA.emit('close');
      await tick();

      // A DIFFERENT controller instance — standing in for a different gateway
      // pod — resumes it. If the relay held state, this could not work.
      const second = build();
      const resB = makeResponse();
      await second.ctrl.streamTaskEvents('gen-7', 'gen-7:1', resB as never);

      const [url, options] = second.http.axiosRef.get.mock.calls[0];
      expect(options.headers['Last-Event-ID']).toBe('gen-7:1');
      expect(url).toContain('last_event_id=gen-7%3A1');

      // Upstream resumes at seq 2 — no gap (nothing between 1 and 2), and no
      // duplicate (seq 1 is not replayed to this reader).
      second.upstream.emit('data', Buffer.from(sseFrame('chunk', { type: 'chunk', content: 'ient' }, 'gen-7:2')));
      second.upstream.emit('end');
      await tick();

      const body = resB.written.join('');
      expect(body).toContain('id: gen-7:2');
      expect(body).not.toContain('id: gen-7:1');
    });
  });

  describe('POST /generate under the single-call contract (§3C.3(1))', () => {
    it('reads generation_id off the FIRST frame and answers with the two-call ack', async () => {
      const { ctrl, http } = build();
      const body = streamOf([sseFrame('meta', { generation_id: 'gen-42' }, 'gen-42:0')]);
      http.axiosRef.post.mockResolvedValue({ data: body });

      const ack = await ctrl.generate({ prompt: 'p', provider: 'lm-studio', model: 'm', stream: true });

      expect(ack.task_id).toBe('gen-42');
      expect(ack.stream_url).toBe('text-generations/tasks/gen-42/stream');
      // The POST must not have been buffered — buffering an SSE body turns a
      // whole clinical generation into a string and returns it as an "ack".
      const [, , options] = http.axiosRef.post.mock.calls[0];
      expect(options.responseType).toBe('stream');
    });

    it('drops the harvest subscription without cancelling the generation', async () => {
      const { ctrl, http } = build();
      const body = streamOf([sseFrame('meta', { generation_id: 'gen-42' }, 'gen-42:0')]);
      http.axiosRef.post.mockResolvedValue({ data: body });

      await ctrl.generate({ prompt: 'p', provider: 'lm-studio', model: 'm', stream: true });

      // The subscription is torn down (the browser will open its own) …
      expect(body.destroy).toHaveBeenCalled();
      // … and the ONLY POST was the generate itself. No cancel.
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
      expect(http.axiosRef.post.mock.calls[0][0]).toContain('/api/v1/generate');
    });

    it('leaves the non-streaming body untouched', async () => {
      const { ctrl, http } = build();
      http.axiosRef.post.mockResolvedValue({ data: { task_id: 't-1', content: 'hello' } });

      const result = await ctrl.generate({ prompt: 'p', provider: 'lm-studio', model: 'm', stream: false });

      expect(result).toEqual({ task_id: 't-1', content: 'hello' });
      const [, , options] = http.axiosRef.post.mock.calls[0];
      expect(options.responseType).toBeUndefined();
    });

    it('fails the open when the stream ends without ever naming its generation', async () => {
      const { ctrl, http } = build();
      const body = streamOf([]);
      http.axiosRef.post.mockResolvedValue({ data: body });

      // A generation whose id we never learned is one nobody can resume, so it
      // must surface as a failure rather than as an ack with an empty id.
      await expect(ctrl.generate({ prompt: 'p', provider: 'lm-studio', model: 'm', stream: true })).rejects.toBeTruthy();
    });
  });
});
