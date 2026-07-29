/**
 * auth-refresh — Client sync tests (TASK-235)
 *
 * Verifies that tryRefreshToken() notifies registered listeners after a
 * successful refresh, so that external HTTP clients (e.g. AgenticClient)
 * receive the new access token immediately.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '@/store/auth-store';
import { tryRefreshToken, registerOnTokenRefreshed, unregisterOnTokenRefreshed } from '../auth-refresh';

const mockUser = {
  id: 'u-1',
  email: 'test@test.com',
  username: 'tester',
  roles: ['admin'],
  permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('tryRefreshToken — client sync (TASK-235)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  it('should call registered listener with the new access token after successful refresh', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const listener = vi.fn();
    registerOnTokenRefreshed(listener);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await tryRefreshToken();

    expect(result).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('new-access');

    unregisterOnTokenRefreshed(listener);
  });

  it('should not call listener when refresh fails', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const listener = vi.fn();
    registerOnTokenRefreshed(listener);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Invalid' }), { status: 401 }));

    const result = await tryRefreshToken();

    expect(result).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    unregisterOnTokenRefreshed(listener);
  });

  it('should support multiple listeners', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const listener1 = vi.fn();
    const listener2 = vi.fn();
    registerOnTokenRefreshed(listener1);
    registerOnTokenRefreshed(listener2);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'new-token', refreshToken: 'new-rt' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await tryRefreshToken();

    expect(listener1).toHaveBeenCalledWith('new-token');
    expect(listener2).toHaveBeenCalledWith('new-token');

    unregisterOnTokenRefreshed(listener1);
    unregisterOnTokenRefreshed(listener2);
  });

  it('should not call listener after it is unregistered', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const listener = vi.fn();
    registerOnTokenRefreshed(listener);
    unregisterOnTokenRefreshed(listener);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'new-token', refreshToken: 'new-rt' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await tryRefreshToken();

    expect(listener).not.toHaveBeenCalled();
  });

  it('should call listener only once even with concurrent refresh calls', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const listener = vi.fn();
    registerOnTokenRefreshed(listener);

    let resolveFirst!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(fetchPromise);

    const call1 = tryRefreshToken();
    const call2 = tryRefreshToken();

    resolveFirst(
      new Response(JSON.stringify({ token: 'shared-token', refreshToken: 'shared-rt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await Promise.all([call1, call2]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('shared-token');

    unregisterOnTokenRefreshed(listener);
  });
});
