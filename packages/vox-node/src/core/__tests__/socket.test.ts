/**
 * TASK-931 — `core/socket.ts`, the zero-dependency WebSocket lane.
 *
 * Two units, tested apart from the resource that composes them: the URL resolution
 * (which is where a socket lane usually breaks — a relative ticket URL, an `http`
 * scheme the socket cannot open) and the frame iterator (which is where it usually
 * leaks — a socket left open when the consumer stops reading).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketUnavailableError } from '../errors';
import { readSocketFrames, resolveSocketUrl } from '../socket';
import { FakeWebSocket } from './support/fake-websocket';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.reset();
});

describe('resolveSocketUrl', () => {
  it('resolves the gateway-relative ticket URL against the base and upgrades the scheme', () => {
    expect(resolveSocketUrl('http://localhost:8868', '/ws/workflows?slug=triage&runId=r1&ticket=t')).toBe(
      'ws://localhost:8868/ws/workflows?slug=triage&runId=r1&ticket=t',
    );
    expect(resolveSocketUrl('https://api.example.com', '/ws/workflows?slug=s&runId=r&ticket=t')).toBe(
      'wss://api.example.com/ws/workflows?slug=s&runId=r&ticket=t',
    );
  });

  it('normalizes a baseUrl that already carries the api/v1 prefix — the socket is not under it', () => {
    expect(resolveSocketUrl('http://localhost:8868/api/v1/', '/ws/workflows?ticket=t')).toBe('ws://localhost:8868/ws/workflows?ticket=t');
  });

  it('honours an ABSOLUTE ticket URL, upgrading its scheme too', () => {
    expect(resolveSocketUrl('http://localhost:8868', 'https://edge.example.com/ws/workflows?ticket=t')).toBe(
      'wss://edge.example.com/ws/workflows?ticket=t',
    );
    expect(resolveSocketUrl('http://localhost:8868', 'wss://edge.example.com/ws?ticket=t')).toBe('wss://edge.example.com/ws?ticket=t');
  });

  it('appends a resume cursor as the `lastEventId` query parameter the gateway reads', () => {
    expect(resolveSocketUrl('http://h', '/ws/workflows?ticket=t', 'cursor-9')).toBe('ws://h/ws/workflows?ticket=t&lastEventId=cursor-9');
  });
});

describe('readSocketFrames', () => {
  it('throws SocketUnavailableError, naming the Node floor, when the global is absent', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const iterate = async (): Promise<void> => {
      for await (const _ of readSocketFrames('ws://h/ws')) void _;
    };
    await expect(iterate()).rejects.toBeInstanceOf(SocketUnavailableError);
    await expect(iterate()).rejects.toThrow(/Node 22/);
  });

  it('yields each decoded frame in order and ends when the server closes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames: unknown[] = [];

    const pump = (async (): Promise<void> => {
      for await (const frame of readSocketFrames('ws://h/ws')) frames.push(frame);
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.progress', id: 'c1', data: { type: 'workflow.run.progress' } }));
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.completed', id: 'c2', data: { type: 'workflow.run.completed' } }));
    socket.emitClose();
    await pump;

    expect(frames).toEqual([
      { event: 'workflow.run.progress', id: 'c1', data: { type: 'workflow.run.progress' } },
      { event: 'workflow.run.completed', id: 'c2', data: { type: 'workflow.run.completed' } },
    ]);
  });

  it('skips a frame it cannot parse rather than tearing down the stream', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames: unknown[] = [];
    const pump = (async (): Promise<void> => {
      for await (const frame of readSocketFrames('ws://h/ws')) frames.push(frame);
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitMessage('{not json');
    socket.emitMessage(JSON.stringify({ event: 'e', data: { ok: true } }));
    socket.emitClose();
    await pump;

    expect(frames).toEqual([{ event: 'e', data: { ok: true } }]);
  });

  it('closes the socket when the consumer stops reading early', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const pump = (async (): Promise<void> => {
      for await (const _frame of readSocketFrames('ws://h/ws')) break;
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitMessage(JSON.stringify({ event: 'e', data: {} }));
    await pump;

    expect(socket.closed).toBe(true);
  });

  it('rejects on a socket error, rather than ending as if the run had finished', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const pump = (async (): Promise<void> => {
      for await (const _ of readSocketFrames('ws://h/ws')) void _;
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitError();

    await expect(pump).rejects.toThrow(/socket/i);
  });

  it('closes the socket when the caller aborts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const controller = new AbortController();
    const pump = (async (): Promise<void> => {
      for await (const _ of readSocketFrames('ws://h/ws', { signal: controller.signal })) void _;
    })();

    const socket = await FakeWebSocket.opened();
    controller.abort();
    await pump.catch(() => undefined);

    expect(socket.closed).toBe(true);
  });
});
