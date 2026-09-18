/**
 * Client-side reaction to a dead session.
 *
 * The BFF already clears the cookie and answers `401 {"message":"Session
 * expired"}`, but the app's only two login redirects (proxy.ts's cookie gate
 * and the console layout's server guard) need a DOCUMENT navigation to fire.
 * An operator already sitting on a screen never performs one, so the screen
 * fills with "Session expired" cards and stays there — TASK-988 D-1.
 */

/** The body `handleProxy` returns once refresh is unrecoverable. */
export const SESSION_EXPIRED_MESSAGE = 'Session expired';

/** Screens reachable without a session; redirecting from one would loop. */
const PUBLIC_PATHS = new Set(['/login', '/register', '/verify-email', '/reset-password']);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * One-shot, because a screen firing a dozen queries against a dead session
 * 401s a dozen times. The flag is never reset: the navigation that follows
 * ends this document.
 */
let redirecting = false;

/**
 * Sends the operator to /login, preserving the destination the way proxy.ts
 * does. A full document navigation rather than `router.replace`, matching
 * logout (`user-menu.tsx`): every client cache — TanStack Query, Zustand,
 * module state — must be dropped along with the identity.
 */
export function redirectToLogin(): void {
  if (typeof window === 'undefined' || redirecting) return;
  const { pathname, search } = window.location;
  if (isPublicPath(pathname)) return;

  redirecting = true;
  const params = new URLSearchParams();
  if (pathname !== '/') params.set('from', `${pathname}${search}`);
  params.set('reason', 'expired');
  window.location.assign(`/login?${params.toString()}`);
}

/**
 * A 401 from the BFF proxy. ONLY the expiry body redirects: once a rotation
 * has succeeded, `handleProxy` passes the GATEWAY's own 401 straight through
 * and deliberately keeps the session, because that 401 is a step-up re-auth
 * failure (a mistyped password on a credential reveal). Logging the operator
 * out for a typo would be worse than the bug this fixes — so an unrecognised
 * or unreadable body does nothing.
 */
export function reportUnauthorized(message: string | undefined): void {
  if (message !== SESSION_EXPIRED_MESSAGE) return;
  redirectToLogin();
}
