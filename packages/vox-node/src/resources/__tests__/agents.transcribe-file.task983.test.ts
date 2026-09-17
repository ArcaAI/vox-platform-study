/**
 * TASK-983 (lane J) — `hope.agents.transcribe(slug, { file })` posted to the wrong route.
 *
 * Reproduced with the built SDK against the dev gateway (2026-09-17): it built a multipart
 * `FormData` and POSTed it to `POST /agents/{slug}/transcriptions`, which is a JSON route
 * (`{ mediaId, consultationId?, language? }` — "the media must already be uploaded"). Every
 * file submission answered `400 mediaId is required`, so the SDK's only batch-ASR entry point
 * could not be used at all.
 *
 * The gateway's FILE entry point is `POST /api/v1/audio/transcription-jobs/transcribe`
 * (multipart `file` + `agentSlug`, scope `stt:transcription:write`) — the same route the browser
 * SDK has always used (`FileTranscriptionService`, `STT_ENDPOINTS.TRANSCRIBE`). This suite pins
 * the route and the form fields per SOURCE SHAPE, so the two shapes can never be conflated again.
 */
import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';

function stubFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error(`stubFetch: no response configured for call ${index}`);
    return next();
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: typeof fetch): HopeClient {
  return new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k-test', fetch: fetchImpl, maxRetries: 0 });
}

const BATCH_ACK = {
  id: 'job-1',
  status: 'QUEUED',
  sseUrl: '/api/v1/audio/transcription-jobs/job-1/stream',
  audioUri: 's3://hope-recordings/2026/09/visit.wav',
  agentSlug: 'clinic-asr',
  agentVersionId: '01924f00-0000-7000-8000-000000000009',
};

describe('agents.transcribe — a FILE goes to the multipart batch route', () => {
  it('POSTs the multipart to /audio/transcription-jobs/transcribe with the agent named in the form', async () => {
    const { fetch, calls } = stubFetch([() => json(BATCH_ACK, 201)]);
    const file = new Blob(['RIFF…'], { type: 'audio/wav' });

    const job = await client(fetch).agents.transcribe('clinic-asr', { file, filename: 'visit.wav', language: 'en' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/audio/transcription-jobs/transcribe');
    expect(calls[0]!.init.method).toBe('POST');
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('agentSlug')).toBe('clinic-asr');
    expect(form.get('language')).toBe('en');
    // The runtime writes the multipart boundary itself — a JSON content type corrupts the upload.
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBeNull();
    expect(job.id).toBe('job-1');
    expect(job.status).toBe('QUEUED');
    expect(job.sseUrl).toBe('/api/v1/audio/transcription-jobs/job-1/stream');
    expect(job.agentSlug).toBe('clinic-asr');
  });

  it('forwards the blob`s own content type and filename — the gateway refuses application/octet-stream', async () => {
    const { fetch, calls } = stubFetch([() => json(BATCH_ACK, 201)]);
    const file = new Blob(['RIFF…'], { type: 'audio/wav' });

    await client(fetch).agents.transcribe('clinic-asr', { file, filename: 'visit.wav' });

    const part = (calls[0]!.init.body as FormData).get('file') as File;
    expect(part).toBeInstanceOf(Blob);
    expect(part.type).toBe('audio/wav');
    expect((part as File).name).toBe('visit.wav');
  });

  it('omits `language` when the caller states none', async () => {
    const { fetch, calls } = stubFetch([() => json(BATCH_ACK, 201)]);

    await client(fetch).agents.transcribe('clinic-asr', { file: new Blob(['x'], { type: 'audio/wav' }) });

    expect((calls[0]!.init.body as FormData).get('language')).toBeNull();
  });
});

describe('agents.transcribe — a MEDIA ID stays on the agent JSON route', () => {
  it('POSTs JSON to /agents/{slug}/transcriptions', async () => {
    const { fetch, calls } = stubFetch([() => json({ id: 'job-2', status: 'QUEUED', jobType: 'BATCH' }, 202)]);

    await client(fetch).agents.transcribe('clinic-asr', { mediaId: 'media-9', language: 'en' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/clinic-asr/transcriptions');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ mediaId: 'media-9', language: 'en' });
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
  });
});
