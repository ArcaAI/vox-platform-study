import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { HopeStreamError } from '../../core/errors';
import { SummarizationResource } from '../summarization';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const RESULT_BODY = {
  pre_summary: 'final pre-summary',
  structured_data: { title: 'Pre-Summary', sections: [] },
  created_at: '2026-01-01T00:00:00Z',
};

describe('SummarizationResource#preSummaryStream', () => {
  it('yields delta/reasoning/result frames in order', async () => {
    const frames = [
      'event: delta\ndata: {"text":"Pat"}\n\n',
      'event: delta\ndata: {"text":"ient"}\n\n',
      'event: reasoning\ndata: {"text":"thinking..."}\n\n',
      `event: result\ndata: ${JSON.stringify(RESULT_BODY)}\n\n`,
    ];
    const fetchImpl = fetchMock(async () => sseResponse(frames));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const events = await collect(resource.preSummaryStream({}));
    expect(events).toEqual([
      { type: 'delta', text: 'Pat' },
      { type: 'delta', text: 'ient' },
      { type: 'reasoning', text: 'thinking...' },
      { type: 'result', data: RESULT_BODY },
    ]);
  });

  it('sets stream: true in the request body', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([`event: result\ndata: ${JSON.stringify(RESULT_BODY)}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await collect(resource.preSummaryStream({}));

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
  });

  it('yields an error frame instead of throwing mid-iteration', async () => {
    const fetchImpl = fetchMock(async () => sseResponse(['event: error\ndata: {"detail":"upstream failed"}\n\n']));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const events = await collect(resource.preSummaryStream({}));
    expect(events).toEqual([{ type: 'error', detail: 'upstream failed' }]);
  });

  it('.result() collapses the stream to the terminal result payload', async () => {
    const frames = ['event: delta\ndata: {"text":"a"}\n\n', `event: result\ndata: ${JSON.stringify(RESULT_BODY)}\n\n`];
    const fetchImpl = fetchMock(async () => sseResponse(frames));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const result = await resource.preSummaryStream({}).result();
    expect(result).toEqual(RESULT_BODY);
  });

  it('.result() throws HopeStreamError on an error frame', async () => {
    const fetchImpl = fetchMock(async () => sseResponse(['event: error\ndata: {"detail":"upstream failed"}\n\n']));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await expect(resource.preSummaryStream({}).result()).rejects.toBeInstanceOf(HopeStreamError);
    await expect(resource.preSummaryStream({}).result()).rejects.toThrow('upstream failed');
  });

  it('.result() throws HopeStreamError if the stream ends without a result frame', async () => {
    const fetchImpl = fetchMock(async () => sseResponse(['event: delta\ndata: {"text":"a"}\n\n']));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await expect(resource.preSummaryStream({}).result()).rejects.toBeInstanceOf(HopeStreamError);
  });

  it(':keepalive comment frames never surface as an event', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([':keepalive\n\n', `event: result\ndata: ${JSON.stringify(RESULT_BODY)}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const events = await collect(resource.preSummaryStream({}));
    expect(events).toEqual([{ type: 'result', data: RESULT_BODY }]);
  });
});

const SUMMARY_RESULT_BODY = {
  summary_id: 's1',
  session_id: 'sess1',
  summary: { chief_complaint: 'headache' },
  created_at: '2026-01-01T00:00:00Z',
  processing_time_ms: 42,
  token_usage: null,
  confidence_score: null,
  metadata: { use_enhanced_format: false },
};

describe('SummarizationResource#summaryStream', () => {
  const sessionData = { created_at: '2026-01-01T00:00:00Z' };

  it('POSTs the compat sync path with stream: true and yields the terminal result', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([`event: result\ndata: ${JSON.stringify(SUMMARY_RESULT_BODY)}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const result = await resource.summaryStream({ session_data: sessionData }).result();
    expect(result).toEqual(SUMMARY_RESULT_BODY);

    const [url, init] = [fetchImpl.mock.calls[0]?.[0] as string, fetchImpl.mock.calls[0]?.[1] as RequestInit];
    expect(url).toBe('http://localhost:8868/api/smr/api/v1/summary/sync');
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });

  it('propagates an AbortSignal into the underlying stream read', async () => {
    const controller = new AbortController();
    const fetchImpl = fetchMock(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          // Never resolves on its own — only abort settles this promise.
          void resolve;
        }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const resource = new SummarizationResource(transport);

    const pending = collect(resource.summaryStream({ session_data: sessionData }, { signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toBeTruthy();
  });
});
