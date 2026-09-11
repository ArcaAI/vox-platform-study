/**
 * TASK-933 lane H2 — `hope.stt.*`, the STT streaming-session lifecycle.
 *
 * The SESSION half only (three ordinary HTTP routes). The socket half lives in
 * `core/__tests__/task933-realtime-stt-socket.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { SttResource } from '../stt';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

function transportWith(fetchImpl: typeof fetch): Transport {
  return new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
}

const SESSION = {
  sessionId: 'sess-1',
  status: 'active',
  wsUrl: '/ws/stt/stream',
  maxConcurrent: 5,
  currentActive: 1,
  ticket: 'tkt-1',
  ticketExpiresAt: 1_800_000_000_000,
  // TASK-951 — the gateway stamps the session epoch at creation; the response type requires it.
  sessionEpochMs: 1_799_999_000_000,
  agentSlug: 'arcaai-asr',
  activeEngine: 'primary' as const,
};

describe('SttResource#createStreamSession', () => {
  it('POSTs audio/transcription-jobs/stream/session and returns the session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, SESSION));
    const stt = new SttResource(transportWith(fetchImpl));

    const session = await stt.createStreamSession({ consultationId: 'c1', agentSlug: 'arcaai-asr', sampleRate: 16000 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/audio/transcription-jobs/stream/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ consultationId: 'c1', agentSlug: 'arcaai-asr', sampleRate: 16000 });
    expect(session.ticket).toBe('tkt-1');
  });

  it('sends an empty body when the caller names nothing (the assignment cascade decides)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, SESSION));
    const stt = new SttResource(transportWith(fetchImpl));

    await stt.createStreamSession();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });
});

describe('SttResource#refreshTicket', () => {
  it('POSTs the per-session refresh route and returns the new ticket', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ticket: 'tkt-2', ticketExpiresAt: 1_800_000_060_000 }));
    const stt = new SttResource(transportWith(fetchImpl));

    const refreshed = await stt.refreshTicket('sess-1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/audio/transcription-jobs/stream/session/sess-1/refresh-ticket');
    expect(refreshed.ticket).toBe('tkt-2');
  });

  it('percent-encodes the session id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ticket: 't', ticketExpiresAt: 1 }));
    const stt = new SttResource(transportWith(fetchImpl));

    await stt.refreshTicket('a/b');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/stream/session/a%2Fb/refresh-ticket');
  });
});

describe('SttResource#closeStreamSession', () => {
  it('DELETEs the session (204, no body)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const stt = new SttResource(transportWith(fetchImpl));

    await stt.closeStreamSession('sess-1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/audio/transcription-jobs/stream/session/sess-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('SttResource#socket', () => {
  it('wires the socket to this client (base URL + a ticket refresher) without connecting', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ticket: 'tkt-2', ticketExpiresAt: 2 }));
    const stt = new SttResource(transportWith(fetchImpl));

    const socket = stt.socket(SESSION);
    expect(socket.sessionId).toBe('sess-1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
