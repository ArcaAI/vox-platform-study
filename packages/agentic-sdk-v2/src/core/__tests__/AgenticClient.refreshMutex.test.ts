/**
 * AgenticClient — Refresh Mutex Tests
 *
 * Verifies that concurrent 401 responses trigger the onUnauthorized handler
 * exactly once, and that all waiting requests retry with the refreshed token.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { mockFetch, createMockResponse, createMockErrorResponse, createMockLogger } from '../../__tests__/setup';

describe('AgenticClient — 401 refresh mutex', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        accessToken: 'expired-token',
        tenantId: 'tenant-1',
      },
      mockLogger,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should call onUnauthorizedHandler only once when multiple concurrent requests get 401', async () => {
    const handlerCallCount = { value: 0 };
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    client.setOnUnauthorized(async () => {
      handlerCallCount.value++;
      await handlerPromise;
      client.updateAccessToken('fresh-token');
      return true;
    });

    // First 3 calls all return 401, then retries succeed
    mockFetch
      .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(createMockResponse({ id: 1 }))
      .mockResolvedValueOnce(createMockResponse({ id: 2 }))
      .mockResolvedValueOnce(createMockResponse({ id: 3 }));

    const req1 = client.get('/api/resource/1');
    const req2 = client.get('/api/resource/2');
    const req3 = client.get('/api/resource/3');

    // Let the handler complete
    resolveHandler();

    const [r1, r2, r3] = await Promise.all([req1, req2, req3]);

    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 2 });
    expect(r3).toEqual({ id: 3 });
    expect(handlerCallCount.value).toBe(1);
  });

  it('should retry all queued requests with the new token after refresh succeeds', async () => {
    client.setOnUnauthorized(async () => {
      client.updateAccessToken('refreshed-token');
      return true;
    });

    mockFetch
      .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(createMockResponse({ ok: true }))
      .mockResolvedValueOnce(createMockResponse({ ok: true }));

    const [r1, r2] = await Promise.all([client.get('/api/a'), client.get('/api/b')]);

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });

    // Verify the retry calls used the refreshed token
    const retryCalls = mockFetch.mock.calls.filter((_call: unknown[], idx: number) => idx >= 2);
    for (const call of retryCalls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer refreshed-token');
    }
  });

  it('should propagate 401 error to all queued requests when refresh fails', async () => {
    client.setOnUnauthorized(async () => {
      return false;
    });

    mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized')).mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

    const results = await Promise.allSettled([client.get('/api/a'), client.get('/api/b')]);

    for (const result of results) {
      expect(result.status).toBe('rejected');
      const error = (result as PromiseRejectedResult).reason as AgenticError;
      expect(error.code).toBe('AUTHENTICATION_ERROR');
    }
  });

  it('should not invoke handler for /auth/refresh endpoint (avoids infinite loop)', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    client.setOnUnauthorized(handler);

    mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

    await expect(client.post('/auth/refresh', { refreshToken: 'rt' })).rejects.toThrow();

    expect(handler).not.toHaveBeenCalled();
  });

  it('should allow a new refresh cycle after the previous one completes', async () => {
    let callCount = 0;
    client.setOnUnauthorized(async () => {
      callCount++;
      client.updateAccessToken(`token-v${callCount}`);
      return true;
    });

    // First cycle: 401 → refresh → retry succeeds
    mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized')).mockResolvedValueOnce(createMockResponse({ cycle: 1 }));

    const r1 = await client.get('/api/first');
    expect(r1).toEqual({ cycle: 1 });
    expect(callCount).toBe(1);

    // Second cycle (new token expired again): 401 → refresh → retry succeeds
    mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized')).mockResolvedValueOnce(createMockResponse({ cycle: 2 }));

    const r2 = await client.get('/api/second');
    expect(r2).toEqual({ cycle: 2 });
    expect(callCount).toBe(2);
  });
});
