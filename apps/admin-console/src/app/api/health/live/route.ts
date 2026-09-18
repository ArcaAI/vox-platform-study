/**
 * Liveness probe — is the Next.js server process running at all?
 *
 * Unconditional and dependency-free on purpose. A probe reporting on THIS
 * process must never be answerable by anything else's state: `apps/api`'s own
 * liveness route (`ApiHealthController#liveness`) carries a long comment about
 * exactly this going wrong — a shared, remotely-exhaustible rate-limit bucket
 * took every `hope-api` pod out of Endpoints with zero real failures. This
 * route has nothing to exhaust and nothing to enumerate: it never touches
 * config, cookies, or the gateway.
 *
 * Reachable without a session — a kubelet carries no cookie. See
 * `src/proxy.ts` PUBLIC_PATHS.
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'healthy' });
}
