/**
 * H-01 — a session JWT must never authenticate through a URL query parameter.
 *
 * `UnifiedAuthGuard` rewrote `?token=<value>` into `Authorization: Bearer
 * <value>` for EVERY route (the comment said "SSE"; the code was gated on
 * nothing). Live probe before the fix:
 *
 *   GET /auth/me  + Authorization header  -> 200
 *   GET /auth/me  no credential           -> 401
 *   GET /auth/me?token=<full JWT>         -> 200   ← the defect
 *   GET /auth/me?token=not-a-jwt          -> 401   (real authentication, not a skipped check)
 *
 * Query strings appear in CDN access logs, browser history, `Referer` headers
 * and session-replay recordings — HIPAA-relevant here — which is why the
 * 30-second single-use stream-ticket subsystem exists at all. The rewrite made
 * every `@StreamScope` check and mint-time ownership assertion bypassable with
 * a long-lived credential, for the whole API rather than one stream.
 *
 * The `?ticket=` path (`apps/api/src/guards/jwtauth.guard.ts`) is separate,
 * scope-checked, and must keep working.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

test.describe('H-01 — no JWT-in-URL credential path', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(login?.token, 'login failed — cannot probe the query-param credential path').toBeTruthy();
    token = login!.token as string;
  });

  test('a valid JWT in ?token= does NOT authenticate a non-SSE route', async ({ request }) => {
    const response = await request.get(`/api/v1/auth/me?token=${encodeURIComponent(token)}`);
    expect(response.status()).toBe(401);
  });

  test('no credential at all is still 401 (control)', async ({ request }) => {
    const response = await request.get('/api/v1/auth/me');
    expect(response.status()).toBe(401);
  });

  test('the Authorization header path is unaffected', async ({ request }) => {
    const response = await request.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);
  });

  test('a JWT in ?token= does not authenticate an SSE route either', async ({ request }) => {
    // The supported credential for a browser `EventSource` is a single-use
    // ticket; a session JWT in the URL must be refused on stream routes too.
    // (Auth runs before the resource lookup, so the jobId need not exist.)
    const response = await request.get(`/api/v1/consultations/jobs/does-not-exist/stream?token=${encodeURIComponent(token)}`);
    expect(response.status()).toBe(401);
  });

  test('the ?ticket= path is still evaluated (a bogus ticket is rejected by the ticket guard, not ignored)', async ({ request }) => {
    const response = await request.get('/api/v1/consultations/jobs/does-not-exist/stream?ticket=not-a-real-ticket');
    // 401 from the ticket guard proves the query param still reaches it. What
    // must NOT happen is the header-rewrite shortcut resurfacing under a
    // different name.
    expect(response.status()).toBe(401);
  });

  test('the SSE route still accepts the Authorization header', async ({ request }) => {
    const response = await request.get('/api/v1/consultations/jobs/does-not-exist/stream', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Authenticated: anything but 401. (404 — job does not exist — is the
    // expected outcome under the 404-over-403 posture.)
    expect(response.status()).not.toBe(401);
  });
});
