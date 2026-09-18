import 'server-only';
import { gatewayUrl } from '@/server/gateway';
import { refreshSession } from '@/server/refresh';
import { clearSession, getSession, isElevated, setSession, type SessionPayload } from '@/server/session';

/**
 * Request headers forwarded verbatim to the gateway (allowlist).
 * `user-agent` rides along so gateway audit rows record the operator's
 * browser, not undici's "node" default.
 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'if-match', 'idempotency-key', 'user-agent'] as const;

/** Response headers surfaced back to the browser (allowlist). Cache-Control
 * rides along so the gateway's `no-store` surfaces (e.g. the Prisma Studio
 * shell) keep their caching posture. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'etag', 'cache-control'] as const;

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Marks a 401 the BFF itself minted because the session is gone, as opposed to
 * a passthrough of the gateway's own 401 — which may be an authorization or
 * step-up failure on a perfectly live session. The client redirects to /login
 * on this header, because the bodies cannot tell the two apart: a missing
 * cookie and a gateway authorization failure both read "Unauthorized".
 * `FORWARDED_RESPONSE_HEADERS` is an allowlist, so the gateway can never
 * inject it — keep it that way.
 */
function sessionLost(message: string): Response {
  return Response.json({ message }, { status: 401, headers: { 'x-session-expired': '1' } });
}

function buildHeaders(request: Request, session: SessionPayload): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = session.impersonation?.accessToken ?? session.accessToken;
  headers.set('authorization', `Bearer ${token}`);
  // Tenant-bound users must never send X-Tenant-Id (gateway 400s on
  // mismatch); elevated users send it only after picking a working tenant.
  // While impersonating, the act-as JWT is already bound to the target's
  // own tenant — the operator's working-tenant pick (selected before
  // impersonating started) must never ride along, or it diverges from the
  // JWT and the gateway 400s every proxied call.
  if (!session.impersonation && session.workingTenantId && isElevated(session.user)) {
    headers.set('x-tenant-id', session.workingTenantId);
  }
  return headers;
}

/**
 * Rebuild the gateway path from Next's catch-all segments, RE-ENCODING each
 * one. `params.path` is percent-DECODED (Next splits the pathname on literal
 * `/` then `decodeURIComponent`s each segment), so a file key that arrived
 * encoded — e.g. `files/2026%2F07%2F.../complete.wav` — reaches us as a single
 * segment holding real slashes. A plain `path.join('/')` would forward those
 * as separator slashes, and the gateway's single-segment
 * `@Get('buckets/:name/files/:key')` route can't match the multi-segment tail
 * → 404. Encoding each segment restores the `%2F` so `:key` matches.
 */
function encodeGatewayPath(path: string[]): string {
  return path.map(encodeURIComponent).join('/');
}

async function sendToGateway(request: Request, path: string[], search: string, session: SessionPayload, body: ArrayBuffer | null): Promise<Response> {
  return fetch(gatewayUrl(encodeGatewayPath(path), search), {
    method: request.method,
    headers: buildHeaders(request, session),
    body: body && body.byteLength > 0 ? body : undefined,
    cache: 'no-store',
    redirect: 'manual',
  });
}

function toClientResponse(gatewayResponse: Response): Response {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = gatewayResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(gatewayResponse.body, { status: gatewayResponse.status, headers });
}

/**
 * BFF catch-all proxy: /api/hope/<path> -> ${API_URL}/api/v1/<path>.
 * Attaches the bearer token server-side (tokens are never client-readable),
 * forwards the optimistic-concurrency headers, and transparently recovers
 * from an expired access token with a single-flight refresh + one retry.
 */
export async function handleProxy(request: Request, path: string[]): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return sessionLost('Unauthorized');
  }

  const { search } = new URL(request.url);
  // Buffer the body once so the 401-retry can resend it.
  const body = BODYLESS_METHODS.has(request.method) ? null : await request.arrayBuffer();

  const first = await sendToGateway(request, path, search, session, body);
  if (first.status !== 401) {
    return toClientResponse(first);
  }

  // Impersonation tokens are non-refreshable: recovery means ending the
  // impersonation and retrying as the original admin. Otherwise rotate the
  // refresh token (single-flight — refresh tokens are single-use).
  let recovered: SessionPayload | null;
  if (session.impersonation) {
    recovered = {
      ...session,
      accessToken: session.impersonation.originalAccessToken,
      refreshToken: session.impersonation.originalRefreshToken,
      impersonation: undefined,
    };
    await setSession(recovered);
  } else {
    recovered = await refreshSession(session);
  }

  if (recovered) {
    const retried = await sendToGateway(request, path, search, recovered, body);
    if (retried.status !== 401) {
      return toClientResponse(retried);
    }
    // The access token was just refreshed, so a lingering 401 is NOT session
    // expiry — it is an authorization / step-up re-auth failure (e.g. a wrong
    // password on reveal/rotate). Surface the gateway's real error and keep
    // the session intact; a mistyped step-up password must not log the user
    // out. (Impersonation keeps the stricter clear-on-401 recovery below.)
    if (!session.impersonation) {
      return toClientResponse(retried);
    }
  }

  await clearSession();
  return sessionLost('Session expired');
}
