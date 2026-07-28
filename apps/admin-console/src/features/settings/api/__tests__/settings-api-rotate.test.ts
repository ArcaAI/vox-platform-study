/**
 * RotateGlobalSetting client contract: POST :id/rotate with
 * If-Match + expectedVersion (OCC like the update PATCH) and the step-up
 * password + new value in the body. The response is the masked setting —
 * no plaintext ever crosses this function.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotateGlobalSetting } from '../client';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response?: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response ? response() : Response.json({ id: 's-1', version: 5, isSecret: true, value: '' }, { headers: { etag: '"5"' } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rotateGlobalSetting', () => {
  it('POSTs to :id/rotate with If-Match, expectedVersion, password and newValue', async () => {
    const calls = installFetchMock();

    const result = await rotateGlobalSetting('s-1', { password: 'admin-password', newValue: 'new-secret' }, '"4"');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/admin/settings/s-1/rotate');
    expect(calls[0].headers.get('if-match')).toBe('"4"');
    expect(calls[0].body).toEqual({ password: 'admin-password', newValue: 'new-secret', expectedVersion: 4 });
    // The fresh ETag comes back for subsequent OCC writes; the value stays masked.
    expect(result.etag).toBe('"5"');
    expect(result.data.version).toBe(5);
    expect(result.data.value).toBe('');
  });
});
