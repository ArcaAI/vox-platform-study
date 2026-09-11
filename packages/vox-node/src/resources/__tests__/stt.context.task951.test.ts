/**
 * TASK-951 lane F — the STT streaming-session `context` echo and the
 * `sessionEpochMs` wall-clock anchor.
 *
 * Hermetic: every gateway call goes through a `fetch` double. Nothing here
 * opens a socket or reaches a live gateway. The gateway-side resolution
 * (validating `context` against a bound agent's frozen schema, minting
 * `sessionEpochMs`, and echoing both onto `transcript` results) is out of
 * scope here — this only proves the SDK sends `context` verbatim on
 * `createStreamSession()` and that the types accept the new shapes.
 */

import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import type { CreateStreamSessionRequest, StreamSessionResponse, SttTranscriptResult } from '../../types/stt';
import { SttResource } from '../stt';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function transportWith(fetchImpl: typeof fetch): Transport {
  return new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
}

const SESSION_WITH_CONTEXT = {
  sessionId: 'sess-1',
  status: 'active',
  wsUrl: '/ws/stt/stream',
  maxConcurrent: 5,
  currentActive: 1,
  ticket: 'tkt-1',
  ticketExpiresAt: 1_800_000_000_000,
  agentSlug: 'realtime-transcription',
  activeEngine: 'primary' as const,
  context: { stream: { mic_id: 'left' } },
  sessionEpochMs: 1_800_000_000_000,
};

describe('SttResource#createStreamSession — context echo (TASK-951)', () => {
  it('sends `context` verbatim in the JSON body, beside the other fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, SESSION_WITH_CONTEXT));
    const stt = new SttResource(transportWith(fetchImpl));

    const request: CreateStreamSessionRequest = {
      agentSlug: 'realtime-transcription',
      context: { stream: { mic_id: 'left' } },
    };

    const session = await stt.createStreamSession(request);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/audio/transcription-jobs/stream/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      agentSlug: 'realtime-transcription',
      context: { stream: { mic_id: 'left' } },
    });
    expect(session.context).toEqual({ stream: { mic_id: 'left' } });
    expect(session.sessionEpochMs).toBe(1_800_000_000_000);
  });

  it('omits `context` entirely when the caller does not supply one (unchanged wire shape)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, SESSION_WITH_CONTEXT));
    const stt = new SttResource(transportWith(fetchImpl));

    await stt.createStreamSession({ agentSlug: 'realtime-transcription' });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody).not.toHaveProperty('context');
  });
});

describe('type shapes (TASK-951)', () => {
  it('`CreateStreamSessionRequest.context` accepts a `{ [kindKey]: payload }` record', () => {
    const request: CreateStreamSessionRequest = {
      agentSlug: 'realtime-transcription',
      context: { stream: { mic_id: 'left', speaker_label: 'Dr. Rao' } },
    };

    expect(request.context).toEqual({ stream: { mic_id: 'left', speaker_label: 'Dr. Rao' } });
  });

  it('`StreamSessionResponse` requires `sessionEpochMs` and accepts an optional `context` echo', () => {
    const response: StreamSessionResponse = {
      sessionId: 'sess-1',
      status: 'active',
      wsUrl: '/ws/stt/stream',
      maxConcurrent: 5,
      currentActive: 1,
      ticket: 'tkt-1',
      ticketExpiresAt: 1_800_000_000_000,
      sessionEpochMs: 1_800_000_000_000,
      context: { stream: { mic_id: 'left' } },
    };

    expect(response.sessionEpochMs).toBe(1_800_000_000_000);
    expect(response.context).toEqual({ stream: { mic_id: 'left' } });
  });

  it('`SttTranscriptResult.context`/`sessionEpochMs` are optional and echo the session', () => {
    const result: SttTranscriptResult = {
      type: 'transcript',
      text: 'left mic caption',
      startTime: 1.2,
      endTime: 2.4,
      isFinal: true,
      context: { stream: { mic_id: 'left' } },
      sessionEpochMs: 1_800_000_000_000,
    };

    expect(result.context).toEqual({ stream: { mic_id: 'left' } });
    expect(result.sessionEpochMs).toBe(1_800_000_000_000);
  });

  it('`SttTranscriptResult` without `context`/`sessionEpochMs` still type-checks (both optional)', () => {
    const result: SttTranscriptResult = {
      type: 'transcript',
      text: 'no session context configured',
      startTime: 0,
      endTime: 1,
      isFinal: false,
    };

    expect(result.context).toBeUndefined();
    expect(result.sessionEpochMs).toBeUndefined();
  });
});
