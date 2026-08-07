import { describe, expect, it, vi } from 'vitest';

import { HopeClient } from './client';
import { ConsultationsResource } from './resources/consultations';
import { ConsultationSummariesResource } from './resources/consultation-summaries';
import { JobsResource } from './resources/jobs';
import { SummarizationResource } from './resources/summarization';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

describe('HopeClient — construction', () => {
  it('throws when baseUrl is missing', () => {
    // @ts-expect-error TS2345 — deliberately omitting the required `baseUrl` option to test the runtime guard
    expect(() => new HopeClient({})).toThrow(/baseUrl/i);
  });

  it('throws when baseUrl is an empty string', () => {
    expect(() => new HopeClient({ baseUrl: '' })).toThrow(/baseUrl/i);
  });

  it('never touches the network at construction time', () => {
    const fetchImpl = fetchMock(async () => okResponse({}));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- constructed only to prove it doesn't call fetch; never referenced afterward
    const client = new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'key', fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wires each resource to the right class, sharing a single transport', () => {
    const client = new HopeClient({ baseUrl: 'http://localhost:8868' });
    expect(client.summarization).toBeInstanceOf(SummarizationResource);
    expect(client.consultations).toBeInstanceOf(ConsultationsResource);
    expect(client.consultations.summaries).toBeInstanceOf(ConsultationSummariesResource);
    expect(client.jobs).toBeInstanceOf(JobsResource);
  });
});

describe('HopeClient — request wiring', () => {
  it('forwards apiKey, tenantId, baseUrl, and the injected fetch to every resource call', async () => {
    const fetchImpl = fetchMock(async () =>
      okResponse({ pre_summary: 'x', structured_data: { title: 't', sections: [] }, created_at: '2026-01-01T00:00:00Z' }),
    );
    const client = new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'key-abc', tenantId: 'tenant-1', fetch: fetchImpl });

    await client.summarization.preSummary({});

    const [url, init] = [fetchImpl.mock.calls[0]?.[0] as string, fetchImpl.mock.calls[0]?.[1] as RequestInit];
    expect(url).toBe('http://localhost:8868/api/smr/api/v1/presummary');
    const headers = init.headers as Headers;
    expect(headers.get('x-api-key')).toBe('key-abc');
    expect(headers.get('x-tenant-id')).toBe('tenant-1');
  });

  it('maps the timeout option onto the transport timeout', async () => {
    const fetchImpl = fetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const client = new HopeClient({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, timeout: 10, maxRetries: 0 });

    await expect(client.consultations.get('c1')).rejects.toBeTruthy();
  });
});
