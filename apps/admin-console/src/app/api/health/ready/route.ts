import { serverEnv } from '@/config/env';

/**
 * Readiness probe — can this BFF pod actually serve traffic?
 *
 * Asserts PROCESS-LEVEL config validity only (`serverEnv()`: `API_URL` parses
 * as a URL, `ADMIN_SESSION_SECRET` is present and long enough) and NEVER
 * calls out to the gateway. That is a deliberate middle, not the easy answer:
 *
 *   - Hard-depending on the gateway (probing `${API_URL}/api/v1/health/live`
 *     from here) would take every admin-console pod out of Endpoints the
 *     moment the gateway blips, turning one outage into two — and the console
 *     can no longer even render a "the API is down" error page for an
 *     operator who lands on it mid-incident, because the pod itself is gone
 *     from the Service.
 *   - Checking nothing (a bare 200, which is what an absent health route is
 *     equivalent to today) leaves a pod that CANNOT construct a single
 *     outbound request — e.g. `ADMIN_SESSION_SECRET` missing, so every
 *     session and every proxied call throws — sitting in Endpoints serving
 *     100% failures.
 *
 * `serverEnv()` failing is a genuine LOCAL fact about this process (every
 * proxied request and every session read/write goes through it), not a
 * downstream dependency, so gating readiness on it is a real signal rather
 * than the same mistake with a shorter timeout.
 *
 * Never leaks which check failed or why: this route is unauthenticated and
 * reachable through the ingress.
 */
export async function GET(): Promise<Response> {
  try {
    serverEnv();
  } catch {
    return Response.json({ status: 'unhealthy', message: 'Service is not ready' }, { status: 503 });
  }
  return Response.json({ status: 'healthy' });
}
