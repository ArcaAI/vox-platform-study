/**
 * Focused unit tests for e2e.helper.ts diagnostics behavior (TASK-260, Fix 1).
 *
 * Scope:
 * - `loginUser` 200 → returns parsed body.
 * - `loginUser` non-2xx → returns null AND logs a structured stderr warning
 *   containing method, URL, status, and a body excerpt.
 * - `loginUser` network/transport error → throws a wrapped error with a clear
 *   "Failed to reach API at <method> <url>" message.
 *
 * The helper accepts a Playwright `APIRequestContext`. We pass a duck-typed
 * mock so this can run as a plain vitest unit test (no live API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIRequestContext } from '@playwright/test';

import { loginUser } from '../e2e.helper';

interface MockResponse {
  status: () => number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function makeMockResponse(status: number, body: unknown): MockResponse {
  const bodyText = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
  return {
    status: () => status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => bodyText,
  };
}

function makeMockRequest(postImpl: (url: string, opts: unknown) => Promise<MockResponse> | MockResponse): APIRequestContext {
  return {
    post: vi.fn(async (url: string, opts: unknown) => postImpl(url, opts)),
  } as unknown as APIRequestContext;
}

describe('loginUser', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns parsed body on HTTP 200', async () => {
    const request = makeMockRequest(() =>
      makeMockResponse(200, {
        token: 'jwt-abc',
        refreshToken: 'rt-xyz',
        user: { id: 'user-1', username: 'super_admin' },
      }),
    );

    const result = await loginUser(request, 'super_admin', 'password123');

    expect(result).toEqual({
      token: 'jwt-abc',
      refreshToken: 'rt-xyz',
      user: { id: 'user-1', username: 'super_admin' },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null and logs a structured stderr warning on HTTP 401', async () => {
    const request = makeMockRequest(() => makeMockResponse(401, { error: 'Invalid credentials' }));

    const result = await loginUser(request, 'super_admin', 'wrong-password');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('POST');
    expect(message).toContain('/api/v1/auth/login');
    expect(message).toContain('401');
    expect(message).toContain('Invalid credentials');
  });

  it('throws a wrapped Error on transport failure (e.g. ECONNREFUSED)', async () => {
    const request = makeMockRequest(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8868');
    });

    await expect(loginUser(request, 'super_admin', 'password123')).rejects.toThrow(/Failed to reach API at POST \/api\/v1\/auth\/login/);

    await expect(loginUser(request, 'super_admin', 'password123')).rejects.toThrow(/ECONNREFUSED/);

    await expect(loginUser(request, 'super_admin', 'password123')).rejects.toThrow(/Is the dev\/test stack running\?/);
  });

  it('truncates large response bodies in the warning to 500 chars', async () => {
    const longBody = 'x'.repeat(2000);
    const request = makeMockRequest(() => makeMockResponse(500, longBody));

    const result = await loginUser(request, 'super_admin', 'password123');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message.length).toBeLessThan(800);
    expect(message).toContain('500');
    expect(message).toMatch(/x{500}…/);
  });
});
