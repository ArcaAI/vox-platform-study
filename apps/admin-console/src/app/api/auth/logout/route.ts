import { activeAccessToken, clientUserAgentHeader, gatewayUrl } from '@/server/gateway';
import { clearSession, getSession } from '@/server/session';

/** Best-effort gateway logout (revokes the jti server-side) + cookie clear. */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (session) {
    try {
      await fetch(gatewayUrl('auth/logout'), {
        method: 'POST',
        headers: { authorization: `Bearer ${activeAccessToken(session)}`, ...clientUserAgentHeader(request) },
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      // The local session is cleared regardless of gateway availability.
    }
  }
  await clearSession();
  return Response.json({ success: true });
}
