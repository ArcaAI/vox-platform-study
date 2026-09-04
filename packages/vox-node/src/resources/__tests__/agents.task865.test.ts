/**
 * TASK-865 — `hope.agents`, the published-Agent invocation plane.
 *
 * Coded against the TASK-863 §3.5 contract (business plane; API key or JWT;
 * `svcScopes: []`):
 *
 * | Route | Method here |
 * |---|---|
 * | `GET /api/v1/agents?task=…` | `list({ task })` |
 * | `GET /api/v1/agents/{slug}` | `get(slug)` |
 * | `POST /api/v1/agents/{slug}/invocations?mode=blocking` | `invoke(slug, input)` |
 * | `POST /api/v1/agents/{slug}/invocations?mode=stream` | `invokeAndStream(slug, input)` |
 * | `POST /api/v1/agents/{slug}/transcriptions` | `transcribe(slug, source)` |
 * | `POST /api/v1/agents/{slug}/speech` | `synthesize(slug, body)` |
 *
 * The routes do not exist in `route-manifest.json` until TASK-863 lands; the
 * sibling `agents.contract.task865.test.ts` checks conformance and skips itself
 * while they are absent. This suite pins what the SDK SENDS.
 */

import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { CredentialClassError } from '../../core/errors';

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

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(type: string, payload: Record<string, unknown>, id?: string): string {
  const envelope = {
    schemaVersion: 1,
    id: '01924f00-0000-7000-8000-000000000001',
    tenantId: '50000000-0000-0000-0000-000000000001',
    type,
    occurredAt: '2026-09-04T00:00:00.000Z',
    correlationId: 'inv-1',
    causationId: null,
    idempotencyKey: `agent:inv:inv-1:${type}`,
    payload,
  };
  return `event: ${type}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(envelope)}\n\n`;
}

const AGENT = {
  slug: 'note-writer',
  name: 'Note Writer',
  description: null,
  task: 'TEXT_GENERATION' as const,
  versionNumber: 4,
  isTenantDefault: true,
  inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  outputSchema: { type: 'object' },
  protocols: ['invocation'],
};

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): HopeClient {
  return new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k-test', fetch: fetchImpl, maxRetries: 0, ...extra });
}

describe('AgentsResource — discovery', () => {
  it('lists published agents from GET /api/v1/agents, filtered by task', async () => {
    const { fetch, calls } = stubFetch([() => json({ data: [AGENT] })]);

    const agents = await client(fetch).agents.list({ task: 'TEXT_GENERATION' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents?task=TEXT_GENERATION');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(agents).toEqual([AGENT]);
  });

  it('lists every task when no filter is given, and never returns null', async () => {
    const { fetch, calls } = stubFetch([() => json({})]);

    const agents = await client(fetch).agents.list();

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents');
    expect(agents).toEqual([]);
  });

  it('reads one agent from GET /api/v1/agents/{slug} (slug path-encoded)', async () => {
    const { fetch, calls } = stubFetch([() => json(AGENT)]);

    const agent = await client(fetch).agents.get('note writer/v2');

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/note%20writer%2Fv2');
    expect(agent.slug).toBe('note-writer');
  });
});

describe('AgentsResource — invocation', () => {
  it('invokes blocking by default: POST …/invocations?mode=blocking with { input }', async () => {
    const { fetch, calls } = stubFetch([() => json({ output: { text: 'SOAP…' } })]);

    const result = await client(fetch).agents.invoke('note-writer', { note: 'hello' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/note-writer/invocations?mode=blocking');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: { note: 'hello' } });
    expect(result.output).toEqual({ text: 'SOAP…' });
  });

  it('sends the caller Idempotency-Key as a HEADER', async () => {
    const { fetch, calls } = stubFetch([() => json({ output: {} })]);

    await client(fetch).agents.invoke('note-writer', {}, { idempotencyKey: 'order-42' });

    expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBe('order-42');
  });

  it('never retries the blocking 504 ceiling', async () => {
    const { fetch, calls } = stubFetch([() => json({ message: 'ceiling' }, 504)]);

    await expect(client(fetch, { maxRetries: 3 }).agents.invoke('note-writer', {})).rejects.toMatchObject({ status: 504 });
    expect(calls).toHaveLength(1);
  });

  it('streams with ?mode=stream and yields each SSE envelope (same frame shape as workflow runs)', async () => {
    const { fetch, calls } = stubFetch([
      () => sse([frame('agent.invocation.progress', { invocationId: 'inv-1', status: 'RUNNING' }, 'c1'), frame('agent.invocation.completed', { invocationId: 'inv-1', status: 'COMPLETED', output: { text: 'done' } }, 'c2')]),
    ]);

    const events = [];
    for await (const event of client(fetch).agents.invokeAndStream('note-writer', { note: 'hello' })) events.push(event);

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/note-writer/invocations?mode=stream');
    expect(new Headers(calls[0]!.init.headers).get('Accept')).toBe('text/event-stream');
    expect(events.map((event) => event.type)).toEqual(['agent.invocation.progress', 'agent.invocation.completed']);
    expect(events[1]!.resumeToken).toBe('c2');
    expect(events[1]!.payload?.output).toEqual({ text: 'done' });
  });
});

describe('AgentsResource — speech and transcription', () => {
  it('synthesizes speech via POST …/speech and hands back the audio body + content type', async () => {
    const { fetch, calls } = stubFetch([() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })]);

    const speech = await client(fetch).agents.synthesize('clinic-tts', { text: 'Take one tablet daily.' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/clinic-tts/speech');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'Take one tablet daily.' });
    expect(speech.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('submits a batch transcription from a file as multipart (no JSON content-type) and returns the job', async () => {
    const { fetch, calls } = stubFetch([() => json({ id: 'job-1', status: 'QUEUED', jobType: 'BATCH' }, 202)]);
    const file = new Blob(['RIFF…'], { type: 'audio/wav' });

    const job = await client(fetch).agents.transcribe('clinic-asr', { file, filename: 'visit.wav', language: 'en' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/clinic-asr/transcriptions');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    const form = calls[0]!.init.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('language')).toBe('en');
    // The runtime sets the multipart boundary itself — a JSON content type would corrupt the upload.
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBeNull();
    expect(job.id).toBe('job-1');
  });

  it('submits a batch transcription from an already-uploaded media id as JSON', async () => {
    const { fetch, calls } = stubFetch([() => json({ id: 'job-2', status: 'QUEUED', jobType: 'BATCH' }, 202)]);

    await client(fetch).agents.transcribe('clinic-asr', { mediaId: 'media-9' });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ mediaId: 'media-9' });
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
  });
});

describe('AgentsResource — credential class', () => {
  it('refuses a service-account client at the call site (the plane is API-key only)', async () => {
    const { fetch, calls } = stubFetch([() => json({ token: 't', expiresIn: 900 })]);
    const hope = new HopeClient({
      baseUrl: 'http://localhost:8868',
      serviceAccount: { clientId: 'c', clientSecret: 's' },
      fetch,
      maxRetries: 0,
    });

    await expect(hope.agents.list()).rejects.toBeInstanceOf(CredentialClassError);
    await expect(hope.agents.invoke('note-writer', {})).rejects.toBeInstanceOf(CredentialClassError);
    expect(calls).toHaveLength(0);
  });
});
