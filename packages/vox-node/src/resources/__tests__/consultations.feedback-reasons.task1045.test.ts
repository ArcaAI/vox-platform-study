import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';

const BASE = 'http://localhost:8868';

describe('consultations.feedbackReasonCodes — no consultation needed', () => {
  it('reads the tenant reason codes without opening or attaching a consultation', async () => {
    const body = { source: 'tenant', items: [{ code: 'missing_information', label: 'Missing information' }] };
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const resource = new ConsultationsResource(new Transport({ baseUrl: BASE, fetch: fetchImpl }));

    await expect(resource.feedbackReasonCodes()).resolves.toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/v1/consultations/feedback/reason-codes`);
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(new Headers(init?.headers).get('x-hope-lifecycle')).toBe('2');
  });
});
