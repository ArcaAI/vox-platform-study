import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `serverEnv()` caches its parsed result at module scope (src/config/env.ts),
// so exercising both the healthy and unhealthy branches in one file needs a
// fresh module instance per test — `vi.resetModules()` + a dynamic import.
const GOOD_SECRET = 'vitest-admin-session-secret-0123456789abcdef';
const ORIGINAL_SECRET = process.env.ADMIN_SESSION_SECRET;
const ORIGINAL_API_URL = process.env.API_URL;

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
    process.env.API_URL = 'http://gateway.test:8868';
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_API_URL === undefined) delete process.env.API_URL;
    else process.env.API_URL = ORIGINAL_API_URL;
  });

  it('reports healthy (200) when required server config is valid', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'healthy' });
  });

  it('reports unhealthy (503) when required config is missing, without leaking why', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    // The route must never surface which variable failed or its validation
    // detail — this is an unauthenticated, internet-reachable probe.
    expect(JSON.stringify(body)).not.toMatch(/ADMIN_SESSION_SECRET/);
  });

  it('reports unhealthy (503) when API_URL is malformed, without leaking the value', async () => {
    process.env.API_URL = 'not-a-url';
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(JSON.stringify(body)).not.toMatch(/not-a-url/);
  });

  it('never calls out to the gateway — no fetch is issued', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { GET } = await import('../route');
    await GET();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
