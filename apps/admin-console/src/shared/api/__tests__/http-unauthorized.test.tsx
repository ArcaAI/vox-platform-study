/**
 * The fetch boundary is where a dead session becomes visible to the client:
 * every proxied call — TanStack query, imperative write, blob download —
 * passes through `request`, so the login redirect is armed there.
 *
 * `.tsx` (not `.test.ts`) purely so these run in the happy-dom project: the
 * module under test reads `window.location`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function stubLocation(pathname: string, search = ''): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname, search, assign });
  return assign;
}

function stubFetch(build: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => build()),
  );
}

/** Fresh module graph per test — the one-shot guard is module state. */
async function loadRequest() {
  return (await import('../http')).request;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session expiry at the fetch boundary', () => {
  it('navigates to /login exactly once when a burst of calls all 401 with the expiry body', async () => {
    const assign = stubLocation('/tenants', '?page=2');
    stubFetch(() => Response.json({ statusCode: 401, message: 'Session expired' }, { status: 401 }));
    const request = await loadRequest();

    const results = await Promise.allSettled(Array.from({ length: 12 }, () => request('admin/tenants')));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?from=%2Ftenants%3Fpage%3D2&reason=expired');
  });

  it('does not navigate on a non-401 failure', async () => {
    const assign = stubLocation('/tenants');
    stubFetch(() => Response.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 }));
    const request = await loadRequest();

    await expect(request('admin/tenants')).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate when a 401 is a step-up re-auth failure rather than session expiry', async () => {
    // handleProxy passes the GATEWAY's own 401 through once a rotation has
    // succeeded — a mistyped password on a credential reveal must not log the
    // operator out.
    const assign = stubLocation('/settings/credentials');
    stubFetch(() => Response.json({ statusCode: 401, message: 'Invalid credentials' }, { status: 401 }));
    const request = await loadRequest();

    await expect(request('admin/credentials/c-1/reveal', { method: 'POST' })).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate on a 401 whose body cannot be read', async () => {
    const assign = stubLocation('/tenants');
    stubFetch(() => new Response('<html>gateway down</html>', { status: 401 }));
    const request = await loadRequest();

    await expect(request('admin/tenants')).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });

  it('never navigates while the login screen is already showing', async () => {
    const assign = stubLocation('/login', '?from=%2Ftenants');
    stubFetch(() => Response.json({ message: 'Session expired' }, { status: 401 }));
    const request = await loadRequest();

    await expect(request('admin/tenants')).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });
});
