/**
 * D-2: rotation used to be purely reactive, so an idle tab only discovered an
 * expired access token through a request that had already failed.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INTERVAL_MS = 15 * 60_000;

function stubLocation(pathname: string): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname, search: '', assign });
  return assign;
}

function stubFetch(build: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => build());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loadHeartbeat() {
  return (await import('../hooks')).useSessionHeartbeat;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSessionHeartbeat', () => {
  it('rotates the session on its interval, and not on mount', async () => {
    stubLocation('/dashboard');
    const fetchMock = stubFetch(() => Response.json({ user: { id: 'u1' } }));
    const useSessionHeartbeat = await loadHeartbeat();

    const { unmount } = renderHook(() => useSessionHeartbeat());
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/auth/refresh', { method: 'POST' }]);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not rotate on a public screen', async () => {
    stubLocation('/login');
    const fetchMock = stubFetch(() => Response.json({ user: { id: 'u1' } }));
    const useSessionHeartbeat = await loadHeartbeat();

    renderHook(() => useSessionHeartbeat());
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the operator to /login when the rotation itself 401s', async () => {
    const assign = stubLocation('/dashboard');
    stubFetch(() => Response.json({ message: 'Session expired' }, { status: 401 }));
    const useSessionHeartbeat = await loadHeartbeat();

    renderHook(() => useSessionHeartbeat());
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?from=%2Fdashboard&reason=expired');
  });
});
