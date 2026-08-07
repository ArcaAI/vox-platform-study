import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { SummarizationResource } from '../summarization';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function callArgs(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): [string, RequestInit] {
  const call = fetchImpl.mock.calls[callIndex];
  if (!call) throw new Error(`fetchImpl was not called (index ${callIndex})`);
  return [call[0] as string, call[1] as RequestInit];
}

describe('SummarizationResource#preSummary', () => {
  it('POSTs to the prefix-exempt compat path, unprefixed', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ pre_summary: 'x', structured_data: { title: 't', sections: [] }, created_at: '2026-01-01T00:00:00Z' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', apiKey: 'key', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await resource.preSummary({ current_department: 'Cardiology' });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/smr/api/v1/presummary');
    expect(init.method).toBe('POST');
  });

  it('sends stream: false and never injects a default temperature/max_tokens', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ pre_summary: 'x', structured_data: { title: 't', sections: [] }, created_at: '2026-01-01T00:00:00Z' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await resource.preSummary({ current_department: 'Cardiology' });

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ current_department: 'Cardiology', stream: false });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('resolves with the parsed PreSummaryResponse', async () => {
    const responseBody = { pre_summary: 'Patient presents with...', structured_data: { title: 'Pre-Summary', sections: [] }, created_at: '2026-01-01T00:00:00Z' };
    const fetchImpl = fetchMock(async () => okResponse(responseBody));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    const result = await resource.preSummary({});
    expect(result).toEqual(responseBody);
  });
});

describe('SummarizationResource#summary', () => {
  const sessionData = { created_at: '2026-01-01T00:00:00Z', conversation_segments: [{ speaker: 'patient', text: 'hi', timestamp: '2026-01-01T00:00:00Z' }] };

  it('POSTs to the prefix-exempt compat path, unprefixed', async () => {
    const fetchImpl = fetchMock(async () =>
      okResponse({
        summary_id: 's1',
        session_id: 'sess1',
        summary: {},
        created_at: '2026-01-01T00:00:00Z',
        processing_time_ms: 10,
        token_usage: null,
        confidence_score: null,
        metadata: { use_enhanced_format: false },
      }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await resource.summary({ session_data: sessionData });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/smr/api/v1/summary/sync');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.session_data).toEqual(sessionData);
  });

  it('does not add temperature/max_tokens defaults the caller omitted', async () => {
    const fetchImpl = fetchMock(async () =>
      okResponse({
        summary_id: 's1',
        session_id: 'sess1',
        summary: {},
        created_at: '2026-01-01T00:00:00Z',
        processing_time_ms: 10,
        token_usage: null,
        confidence_score: null,
        metadata: { use_enhanced_format: false },
      }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new SummarizationResource(transport);

    await resource.summary({ session_data: sessionData });

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect('temperature' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
  });
});
