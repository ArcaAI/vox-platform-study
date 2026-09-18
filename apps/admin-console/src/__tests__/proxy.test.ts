import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import proxy from '../proxy';

function requestFor(pathname: string, cookie?: string): NextRequest {
  const headers = cookie ? { cookie } : undefined;
  return new NextRequest(new Request(`http://console.local${pathname}`, { headers }));
}

describe('proxy (public register/verify-email routes)', () => {
  it.each(['/register', '/verify-email', '/api/auth/register', '/api/auth/register/verify'])(
    'lets an unauthenticated request through to %s',
    (path) => {
      const response = proxy(requestFor(path));
      expect(response.status).toBe(200); // NextResponse.next() reports 200/no redirect
    },
  );

  it('still redirects an unauthenticated request to a protected page', () => {
    const response = proxy(requestFor('/tenants'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('still 401s an unauthenticated request to a protected API route', () => {
    const response = proxy(requestFor('/api/hope/admin/tenants'));
    expect(response.status).toBe(401);
  });

  /**
   * This 401 short-circuits `handleProxy`, so the BFF's own `x-session-expired`
   * header never gets a chance to be stamped — and a missing cookie is the
   * COMMONEST way a session ends (`clearSession()` deletes it, so every request
   * after the first lands here). Without the header the console cannot tell
   * session loss from an authorization failure, and the operator is left on a
   * dead screen: the exact defect TASK-988 exists to fix.
   */
  it('marks that API 401 as session loss so the client redirects to /login', () => {
    const response = proxy(requestFor('/api/hope/admin/tenants'));
    expect(response.headers.get('x-session-expired')).toBe('1');
  });
});

describe('proxy (public SSO and password-reset routes)', () => {
  it.each([
    '/api/auth/sso/start',
    '/api/auth/sso/callback',
    '/reset-password',
    '/api/auth/reset-password',
    '/api/auth/forgot-password',
  ])('lets an unauthenticated request through to %s', (path) => {
    const response = proxy(requestFor(path));
    expect(response.status).toBe(200); // NextResponse.next() reports 200/no redirect
  });
});

describe('proxy (public Kubernetes health probes — TASK-990)', () => {
  it.each(['/api/health', '/api/health/live', '/api/health/ready'])(
    'lets an unauthenticated request (no session cookie, as a kubelet sends) through to %s',
    (path) => {
      const response = proxy(requestFor(path));
      expect(response.status).toBe(200); // NextResponse.next() reports 200/no redirect
    },
  );

  it('does not widen access to a health-adjacent path that was never allow-listed', () => {
    // Exact-match only: `/api/health` being public must not make
    // `/api/health/services` (or any other suffix) public by prefix.
    const response = proxy(requestFor('/api/health/services'));
    expect(response.status).toBe(401);
  });
});
