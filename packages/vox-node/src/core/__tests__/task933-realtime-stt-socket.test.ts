/**
 * TASK-933 lane H2 — `RealtimeSttSocket`, the Node client for HOPE's
 * `/ws/stt/stream` protocol.
 *
 * Hermetic: `globalThis.WebSocket` is stubbed with {@link FakeWebSocket}, which
 * is the same lookup the shipped code performs. No socket is ever opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SocketUnavailableError } from '../errors';
import { RealtimeSttSocket } from '../realtime-stt-socket';
import { FakeWebSocket } from './support/fake-websocket';

const SESSION = {
  sessionId: 'sess-1',
  ticket: 'tkt-1',
  ticketExpiresAt: 4_000_000_000_000,
  wsUrl: '/ws/stt/stream',
};

function makeSocket(overrides: Partial<ConstructorParameters<typeof RealtimeSttSocket>[0]> = {}): RealtimeSttSocket {
  return new RealtimeSttSocket({
    baseUrl: 'http://localhost:8868',
    session: SESSION,
    now: () => 1_000,
    sleep: async () => undefined,
    ...overrides,
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RealtimeSttSocket#connect', () => {
  it('opens ws://…/ws/stt/stream with the sessionId and ticket, and never a credential', async () => {
    const socket = makeSocket();
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    const url = new URL(opened.url);
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/ws/stt/stream');
    expect(url.searchParams.get('sessionId')).toBe('sess-1');
    expect(url.searchParams.get('ticket')).toBe('tkt-1');
    expect(opened.url).not.toContain('Bearer');
    expect(url.searchParams.get('token')).toBeNull();
  });

  it('upgrades an https base URL to wss and carries an explicit tenantId', async () => {
    const socket = makeSocket({ baseUrl: 'https://api.example.test/api/v1', tenantId: 't-1' });
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    const url = new URL(opened.url);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.example.test');
    expect(url.searchParams.get('tenantId')).toBe('t-1');
  });

  it('throws SocketUnavailableError on a runtime with no global WebSocket', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const socket = makeSocket();
    await expect(socket.connect()).rejects.toBeInstanceOf(SocketUnavailableError);
  });

  it('refreshes the ticket before connecting when the one it holds has expired', async () => {
    const refreshTicket = vi.fn(async () => ({ ticket: 'tkt-fresh', ticketExpiresAt: 9_000 }));
    const socket = makeSocket({
      session: { ...SESSION, ticketExpiresAt: 500 },
      now: () => 1_000,
      refreshTicket,
    });

    const connecting = socket.connect();
    await Promise.resolve();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    expect(refreshTicket).toHaveBeenCalledWith('sess-1');
    expect(new URL(opened.url).searchParams.get('ticket')).toBe('tkt-fresh');
  });
});

describe('RealtimeSttSocket — sending', () => {
  it('sends PCM16 frames as binary and control messages as JSON', async () => {
    const socket = makeSocket();
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    socket.sendPcm16(new Uint8Array([1, 2, 3, 4]));
    const finalized = socket.finalize();
    opened.emitMessage(JSON.stringify({ type: 'status', status: 'closed' }));
    await finalized;

    expect(opened.sent[0]).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(String(opened.sent[1]))).toEqual({ type: 'stop' });

    socket.close();
    expect(JSON.parse(String(opened.sent[2]))).toEqual({ type: 'close' });
    expect(opened.closed).toBe(true);
  });

  it('refuses to send before connect() rather than dropping audio silently', () => {
    const socket = makeSocket();
    expect(() => socket.sendPcm16(new Uint8Array([1]))).toThrow(/not connected/i);
  });
});

describe('RealtimeSttSocket#finalize', () => {
  // TASK-985 M-05 — the old title claimed the gateway "finalizes AND closes the
  // session for it". It does not close the socket, and the doc comment saying
  // so is what left callers closing on their own schedule (or not at all).
  it('sends the {type:"stop"} wire frame and resolves on the terminal status', async () => {
    const socket = makeSocket();
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    const finalized = socket.finalize();
    expect(JSON.parse(String(opened.sent[0]))).toEqual({ type: 'stop' });

    // Still pending: the tail has not been delivered yet, which is precisely
    // what a caller needs to be able to wait for.
    opened.emitMessage(JSON.stringify({ type: 'status', status: 'finalizing' }));
    opened.emitMessage(JSON.stringify({ type: 'transcript', text: 'the tail', isFinal: true, seq: 9 }));
    opened.emitMessage(JSON.stringify({ type: 'status', status: 'closed' }));

    await expect(finalized).resolves.toBeUndefined();
    // It does NOT close the socket — `close()` is what sends `{type:'close'}`.
    expect(opened.closed).toBe(false);
    expect(opened.sent.map((frame) => String(frame))).not.toContain(JSON.stringify({ type: 'close' }));
  });

  it('resolves (never rejects) when the server answers nothing at all', async () => {
    vi.useFakeTimers();
    try {
      const socket = makeSocket();
      const connecting = socket.connect();
      const opened = await FakeWebSocket.opened();
      opened.emitOpen();
      await connecting;

      const finalized = socket.finalize(1_000);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(finalized).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RealtimeSttSocket#waitForClosed', () => {
  it('resolves with the close event once the transport actually tears down', async () => {
    const socket = makeSocket();
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    const closing = socket.waitForClosed();
    socket.close();
    opened.emitClose(1000);

    await expect(closing).resolves.toMatchObject({ code: 1000, requested: true });
  });
});

describe('RealtimeSttSocket — ready and gap frames (TASK-985 M-22 / M-43)', () => {
  it('emits `ready` instead of silently ignoring the gateway\'s first frame', async () => {
    const socket = makeSocket();
    const ready = vi.fn();
    socket.on('ready', ready);
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    opened.emitMessage(JSON.stringify({ type: 'ready', sessionId: 'sess-1', fromSeq: 1 }));

    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', sessionId: 'sess-1', fromSeq: 1 }));
  });

  it('emits `gap` on its own channel, NOT as an error — a discarded result is an outcome, not a retry', async () => {
    const socket = makeSocket();
    const gap = vi.fn();
    const error = vi.fn();
    socket.on('gap', gap);
    socket.on('error', error);
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    opened.emitMessage(JSON.stringify({ type: 'gap', reason: 'egress_overflow', sessionId: 'sess-1', droppedSeq: 12 }));

    expect(gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'egress_overflow', droppedSeq: 12 }));
    expect(error).not.toHaveBeenCalled();
  });
});

describe('RealtimeSttSocket#stop (deprecated)', () => {
  it('is an alias for finalize() — same wire frame, same session-ending behavior', async () => {
    const socket = makeSocket();
    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    const stopped = socket.stop();
    opened.emitMessage(JSON.stringify({ type: 'status', status: 'closed' }));
    await stopped;

    expect(JSON.parse(String(opened.sent[0]))).toEqual({ type: 'stop' });
  });
});

describe('RealtimeSttSocket — server frames', () => {
  it('emits typed transcript / status / error / resumed events', async () => {
    const socket = makeSocket();
    const transcripts: unknown[] = [];
    const statuses: unknown[] = [];
    const errors: unknown[] = [];
    const resumes: unknown[] = [];

    socket.on('transcript', (event) => transcripts.push(event));
    socket.on('status', (event) => statuses.push(event));
    socket.on('error', (event) => errors.push(event));
    socket.on('resumed', (event) => resumes.push(event));

    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;

    opened.emitMessage(JSON.stringify({ type: 'transcript', text: 'hello', startTime: 0, endTime: 1, isFinal: true, seq: 7 }));
    opened.emitMessage(JSON.stringify({ type: 'status', status: 'connected' }));
    opened.emitMessage(JSON.stringify({ type: 'error', code: 'X', message: 'boom' }));
    opened.emitMessage(JSON.stringify({ type: 'resumed', sessionId: 'sess-1', fromSeq: 8 }));
    opened.emitMessage('not json at all');

    expect(transcripts).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(resumes).toHaveLength(1);
    expect(socket.lastSeq).toBe(7);
  });

  it('emits close when the server hangs up', async () => {
    const socket = makeSocket({ autoResume: false });
    const closes: unknown[] = [];
    socket.on('close', (event) => closes.push(event));

    const connecting = socket.connect();
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    await connecting;
    opened.emitClose(1006);

    expect(closes).toHaveLength(1);
  });
});

describe('RealtimeSttSocket#resume', () => {
  it('mints a fresh ticket, reopens, and sends the resume handshake with the last seq', async () => {
    const refreshTicket = vi.fn(async () => ({ ticket: 'tkt-2', ticketExpiresAt: 9_000_000_000_000 }));
    const socket = makeSocket({ refreshTicket, autoResume: false });

    const connecting = socket.connect();
    const first = await FakeWebSocket.opened();
    first.emitOpen();
    await connecting;
    first.emitMessage(JSON.stringify({ type: 'transcript', text: 'a', startTime: 0, endTime: 1, isFinal: true, seq: 12 }));
    first.emitClose(1006);

    const resuming = socket.resume();
    await Promise.resolve();
    await Promise.resolve();
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second.emitOpen();
    await resuming;

    expect(refreshTicket).toHaveBeenCalledWith('sess-1');
    expect(new URL(second.url).searchParams.get('ticket')).toBe('tkt-2');
    expect(JSON.parse(String(second.sent[0]))).toEqual({ type: 'resume', sessionId: 'sess-1', lastSeq: 12 });
  });

  it('auto-resumes after an unexpected close when a ticket refresher is wired', async () => {
    const refreshTicket = vi.fn(async () => ({ ticket: 'tkt-2', ticketExpiresAt: 9_000_000_000_000 }));
    const socket = makeSocket({ refreshTicket });

    const connecting = socket.connect();
    const first = await FakeWebSocket.opened();
    first.emitOpen();
    await connecting;
    first.emitClose(1006);

    for (let i = 0; i < 10 && FakeWebSocket.instances.length < 2; i++) await Promise.resolve();
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second.emitOpen();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(JSON.parse(String(second.sent[0])).type).toBe('resume');
  });

  it('does NOT auto-resume after the caller closed the socket', async () => {
    const refreshTicket = vi.fn(async () => ({ ticket: 'tkt-2', ticketExpiresAt: 9_000_000_000_000 }));
    const socket = makeSocket({ refreshTicket });

    const connecting = socket.connect();
    const first = await FakeWebSocket.opened();
    first.emitOpen();
    await connecting;
    socket.close();
    first.emitClose(1000);

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(refreshTicket).not.toHaveBeenCalled();
  });
});
