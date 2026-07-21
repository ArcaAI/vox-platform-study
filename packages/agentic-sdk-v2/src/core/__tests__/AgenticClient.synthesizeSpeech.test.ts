/**
 * AgenticClient.synthesizeSpeech (gateway TTS proxy).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLogger, createMockResponse, mockFetch } from '../../__tests__/setup';
import { AgenticClient } from '../AgenticClient';

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

describe('AgenticClient.synthesizeSpeech (TASK-491)', () => {
  let client: AgenticClient;

  beforeEach(() => {
    client = new AgenticClient({ baseUrl: 'https://api.example.com', tenantId: 'tenant-1' }, createMockLogger());
    client.updateAccessToken('jwt-token');
  });

  afterEach(() => vi.clearAllMocks());

  it('POSTs to /speech/synthesize with auth + input/voice body and returns the raw response', async () => {
    const resp = createMockResponse({}, { ok: true });
    mockFetch.mockResolvedValueOnce(resp);

    const result = await client.synthesizeSpeech('Read this aloud.', { voice: 'en-female-1' });

    expect(result).toBe(resp);
    const [url, init] = mockFetch.mock.calls[0] as [string, FetchInit];
    expect(url).toBe('https://api.example.com/speech/synthesize');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer jwt-token');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Accept']).toContain('application/octet-stream');
    expect(init.headers['X-Tenant-ID']).toBe('tenant-1');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      input: 'Read this aloud.',
      voice: 'en-female-1',
      response_format: 'pcm',
      stream_format: 'audio',
    });
  });

  it('honors response_format / speed overrides', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({}, { ok: true }));
    await client.synthesizeSpeech('ഹലോ.', { voice: 'ml-female-1', response_format: 'wav', speed: 1.25 });
    const init = mockFetch.mock.calls[0][1] as FetchInit;
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ voice: 'ml-female-1', response_format: 'wav', speed: 1.25 });
  });

  it('throws an AgenticError on a non-ok upstream status', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({}, { ok: false, status: 503, statusText: 'Service Unavailable' }));
    await expect(client.synthesizeSpeech('hi', { voice: 'en-female-1' })).rejects.toMatchObject({
      code: expect.any(String),
    });
  });
});
