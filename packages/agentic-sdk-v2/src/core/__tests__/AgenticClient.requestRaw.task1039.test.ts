/**
 * AgenticClient — `requestRaw` (TASK-1039)
 *
 * The one place the browser SDK reads a response it must NOT JSON-parse for itself: a long-lived
 * `text/event-stream` (agent runs, where the gateway mints no run-scoped ticket) and the run
 * result route (whose `X-Hope-Result-Kind` header decides how to read the body, and which answers
 * 204). Carries the client's own credentials; no timeout on the connection.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';

describe('AgenticClient — requestRaw', () => {
  let client: AgenticClient;

  beforeEach(() => {
    client = new AgenticClient({ baseUrl: 'https://api.example.com/api/v1', apiKey: 'key-1', tenantId: 'tenant-9', accessToken: 'jwt-1' });
  });

  it('returns the raw Response with the client credentials and the caller headers', async () => {
    const response = createMockResponse({ ok: true });
    mockFetch.mockResolvedValueOnce(response);

    const raw = await client.requestRaw('/agents/a/runs/r/events?protocol=2', { headers: { Accept: 'text/event-stream', 'Last-Event-ID': '4' } });

    expect(raw).toBe(response);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/agents/a/runs/r/events?protocol=2',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-1', 'X-API-Key': 'key-1', 'X-Tenant-ID': 'tenant-9', 'Last-Event-ID': '4', Accept: 'text/event-stream' }),
      }),
    );
  });

  it('forwards the abort signal', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({}));
    const controller = new AbortController();

    await client.requestRaw('/x', { signal: controller.signal });

    expect(mockFetch.mock.calls[0]![1].signal).toBe(controller.signal);
  });

  it('lets a 204 through (the result route answers it for "nothing delivered")', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(null, { status: 204 }));
    expect((await client.requestRaw('/x')).status).toBe(204);
  });

  it('throws an AgenticError that keeps the status and the gateway code on a non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockErrorResponse(409, 'Run has not finished.', { json: () => Promise.resolve({ code: 'RUN_NOT_TERMINAL', message: 'Run has not finished.' }) } as Partial<Response>),
    );

    const failure = client.requestRaw('/agents/a/runs/r/result');

    await expect(failure).rejects.toBeInstanceOf(AgenticError);
    await expect(failure).rejects.toMatchObject({ context: { status: 409, code: 'RUN_NOT_TERMINAL' } });
  });

  it('retries once through the unauthorized handler on a 401', async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    client.setOnUnauthorized(refresh);
    mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'expired')).mockResolvedValueOnce(createMockResponse({ ok: true }));

    const raw = await client.requestRaw('/x');

    expect(raw.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('turns a network failure into a NETWORK_ERROR AgenticError (the engine treats it as transient)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(client.requestRaw('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
