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
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
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
