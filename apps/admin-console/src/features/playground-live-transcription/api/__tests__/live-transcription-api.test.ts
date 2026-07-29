/**
 * Playground live-transcription API layer. Everything REST rides
 * the BFF catch-all (gateway-relative paths, END-USER plane — no `admin/`
 * prefix); the WS URL builder targets the gateway origin directly with the
 * sessionId/ticket/tenantId trio the handshake guards require.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicEnv } from '@/config/public-env';
import {
  buildStreamWsUrl,
  cancelTranscriptionJob,
  closeStreamSession,
  createStreamSession,
  getTranscriptionJob,
  jobStreamPath,
  listMyTranscriptionJobs,
  listPlaygroundPipelines,
  refreshStreamTicket,
  retryTranscriptionJob,
  uploadBatchAudio,
} from '../client';
import { liveTranscriptionKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('liveTranscriptionKeys', () => {
  it('separates pipelines, jobs and job detail under one root', () => {
    expect(liveTranscriptionKeys.pipelines()[0]).toBe('playground-live-transcription');
    expect(liveTranscriptionKeys.jobs()).not.toEqual(liveTranscriptionKeys.pipelines());
    expect(liveTranscriptionKeys.jobs({ page: 1 })).toEqual(liveTranscriptionKeys.jobs({ page: 1 }));
    expect(liveTranscriptionKeys.jobs({ page: 1 })).not.toEqual(liveTranscriptionKeys.jobs({ page: 2 }));
    expect(liveTranscriptionKeys.job('j-1')).not.toEqual(liveTranscriptionKeys.job('j-2'));
  });
});

describe('stream session client', () => {
  it('creates, refreshes and deletes stream sessions on the end-user plane', async () => {
    const calls = installFetchMock();
    await createStreamSession({ pipelineId: 'p-1', sampleRate: 16000 });
    await refreshStreamTicket('s-9d42');
    await closeStreamSession('s-9d42');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/audio/transcription-jobs/stream/session',
      'POST /api/hope/audio/transcription-jobs/stream/session/s-9d42/refresh-ticket',
      'DELETE /api/hope/audio/transcription-jobs/stream/session/s-9d42',
    ]);
    expect(calls[0].body).toEqual({ pipelineId: 'p-1', sampleRate: 16000 });
  });
});

describe('batch + jobs client', () => {
  it('uploads multipart FormData with the file and pipelineId fields', async () => {
    const calls = installFetchMock();
    const file = new File(['RIFF'], 'visit.wav', { type: 'audio/wav' });
    await uploadBatchAudio({ file, pipelineId: 'p-1' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/audio/transcription-jobs/transcribe');
    const body = calls[0].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('pipelineId')).toBe('p-1');
    expect(body.get('file')).toBeInstanceOf(File);
    expect((body.get('file') as File).name).toBe('visit.wav');
  });

  it('reads the owner-scoped job surfaces and mutates cancel/retry', async () => {
    const calls = installFetchMock();
    await listMyTranscriptionJobs({ page: 1, limit: 10 });
    await getTranscriptionJob('j-8841');
    await cancelTranscriptionJob('j-8841');
    await retryTranscriptionJob('j-8841');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/audio/transcription-jobs?page=1&limit=10',
      'GET /api/hope/audio/transcription-jobs/j-8841',
      'POST /api/hope/audio/transcription-jobs/j-8841/cancel',
      'POST /api/hope/audio/transcription-jobs/j-8841/retry',
    ]);
  });

  it('lists pipelines from the public end-user read', async () => {
    const calls = installFetchMock();
    await listPlaygroundPipelines();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/audio/pipelines']);
  });

  it('exposes the gateway-relative SSE path for useEventStream', () => {
    expect(jobStreamPath('j-8841')).toBe('audio/transcription-jobs/j-8841/stream');
  });
});

describe('buildStreamWsUrl', () => {
  it('derives ws:// from an http gateway origin and carries sessionId, ticket and tenantId', () => {
    const url = buildStreamWsUrl('http://localhost:8868', '/ws/stt/stream', {
      sessionId: 's-9d42',
      ticket: 'tkt-abc',
      tenantId: 'tnt-1',
    });
    expect(url).toBe('ws://localhost:8868/ws/stt/stream?sessionId=s-9d42&ticket=tkt-abc&tenantId=tnt-1');
  });

  it('derives wss:// from an https origin and encodes params round-trippably', () => {
    const url = buildStreamWsUrl('https://api.hope.example', '/ws/stt/stream', {
      sessionId: 's 1',
      ticket: 't+k',
      tenantId: 'tnt-1',
    });
    expect(url.startsWith('wss://api.hope.example/ws/stt/stream?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('sessionId')).toBe('s 1');
    expect(parsed.searchParams.get('ticket')).toBe('t+k');
    expect(parsed.searchParams.get('tenantId')).toBe('tnt-1');
  });

  it('defaults to the publicEnv gateway host contract used by the hook', () => {
    // publicEnv.apiHost is the documented WS origin — assert the builder
    // accepts it verbatim (http(s) origin, no trailing slash handling bugs).
    const url = buildStreamWsUrl(publicEnv.apiHost, '/ws/stt/stream', { sessionId: 's-1', ticket: 't-1', tenantId: 'tnt-1' });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/ws/stt/stream');
    expect(['ws:', 'wss:']).toContain(parsed.protocol);
  });
});
