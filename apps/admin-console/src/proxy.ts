import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/shared/auth/session-cookie';

/**
 * Next 16 request proxy (the middleware.ts replacement, rule 13): a fast
 * cookie-PRESENCE gate only. Decryption/validation happens in the BFF route
 * handlers — a forged cookie gets through here but fails there.
 */

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  // Verified self-signup: public until the account is created +
  // verified. The gateway itself 404s both routes when
  // REGISTRATION_SELF_SIGNUP_ENABLED is off, so this allowlist entry alone
  // does not widen access.
  '/register',
  '/verify-email',
  '/api/auth/register',
  '/api/auth/register/verify',
  // SSO: /sso/start is called from the login form before a session exists;
  // /sso/callback is a top-level GET the IdP redirects the browser to
  // directly, also pre-session.
  '/api/auth/sso/start',
  '/api/auth/sso/callback',
  // Self-service password reset: the page is opened from an emailed link
  // (no session yet), and its submit route is called from that same page.
  '/reset-password',
  '/api/auth/reset-password',
  '/api/auth/forgot-password',
  // Kubernetes probes (TASK-990): a kubelet carries no session cookie, so
  // these three must be reachable unauthenticated. Exact-path match only —
  // nothing else under /api/health is opened, and none of the three returns
  // anything session-scoped; see src/app/api/health/{,live/,ready/}route.ts
  // for what each one asserts.
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
]);

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname) || request.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    // `x-session-expired` marks a 401 minted because the session is GONE, as
    // opposed to a gateway authorization / step-up failure on a live session —
    // the bodies cannot be told apart, since both read "Unauthorized". The same
    // header is stamped by `hope-proxy.ts`, but this branch short-circuits it:
    // a missing cookie never reaches a route handler, and that is the commonest
    // way a session ends, because `clearSession()` deletes the cookie and every
    // request after the first one lands here.
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401, headers: { 'x-session-expired': '1' } });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  // Preserve the intended destination so login can return the user there.
  if (pathname !== '/') {
    loginUrl.searchParams.set('from', `${pathname}${request.nextUrl.search}`);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip Next internals and static assets entirely (no work on them).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)'],
};
