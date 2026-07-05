import { clientUserAgentHeader, gatewayUrl } from '@/server/gateway';
import { toSafeSession } from '@/server/safe-user';
import { getSession, setSession } from '@/server/session';

/**
 * Ends impersonation: best-effort gateway revocation of the act-as token's
 * jti, then restores the original admin token pair in the session.
 */
export async function POST(request: Request): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    if (!session.impersonation) {
        return Response.json({ message: 'Not currently impersonating' }, { status: 400 });
    }

    try {
        await fetch(gatewayUrl('auth/revoke-impersonation'), {
            method: 'POST',
            headers: { authorization: `Bearer ${session.impersonation.accessToken}`, ...clientUserAgentHeader(request) },
            cache: 'no-store',
            redirect: 'manual',
        });
    } catch {
        // The act-as token is short-lived; restoring the session must not
        // depend on gateway availability.
    }

    const updated = {
        ...session,
        accessToken: session.impersonation.originalAccessToken,
        refreshToken: session.impersonation.originalRefreshToken,
        impersonation: undefined,
    };
    await setSession(updated);
    return Response.json(toSafeSession(updated));
}
