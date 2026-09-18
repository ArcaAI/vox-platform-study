/**
 * Client-side reaction to a dead session.
 *
 * The BFF already clears the cookie and answers 401, but the app's only two
 * login redirects (proxy.ts's cookie gate and the console layout's server
 * guard) need a DOCUMENT navigation to fire. An operator already sitting on a
 * screen never performs one, so the screen fills with "Session expired" cards
 * and stays there — TASK-988 D-1.
 */

/**
 * Response header the BFF stamps on its OWN 401s — the missing-cookie branch
 * and the refresh-is-unrecoverable branch — and never on a passthrough of the
 * gateway's answer. It is the signal because the bodies are ambiguous: the
 * missing-cookie branch says `"Unauthorized"`, which is exactly what the
 * gateway says when a step-up re-auth fails. `toClientResponse` copies only an
 * allowlist of gateway headers, so the gateway cannot forge this one.
 */
const SESSION_EXPIRED_HEADER = 'x-session-expired';

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
 * A 401 from the BFF proxy. Without the header it is a step-up re-auth failure
 * (a mistyped password on a credential reveal), which `handleProxy` passes
 * through with the session deliberately intact — logging the operator out for
 * a typo would be worse than the bug this fixes. The body is never consulted,
 * so an unreadable one changes nothing either way.
 */
export function reportUnauthorized(response: Response): void {
  if (!response.headers.has(SESSION_EXPIRED_HEADER)) return;
  redirectToLogin();
}
