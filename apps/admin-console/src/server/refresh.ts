import 'server-only';
import { gatewayUrl } from '@/server/gateway';
import { clearSession, getSession, setSession, type SessionPayload } from '@/server/session';

interface RefreshTokenResponse {
    token: string;
    refreshToken: string;
}

/**
 * Single-flight guard: the gateway's refresh tokens are SINGLE-USE, so two
 * concurrent 401 recoveries must share one rotation (the loser of the race
 * would otherwise burn an already-rotated token and kill the session).
 */
let inFlight: Promise<SessionPayload | null> | null = null;

async function rotate(session: SessionPayload): Promise<SessionPayload | null> {
    const response = await fetch(gatewayUrl('auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!response.ok) {
        await clearSession();
        return null;
    }

    const data = (await response.json()) as RefreshTokenResponse;
    // Re-read the cookie in case another request mutated non-token state
    // (e.g. workingTenantId) while the rotation was in flight.
    const current = (await getSession()) ?? session;
    const updated: SessionPayload = {
        ...current,
        accessToken: data.token,
        refreshToken: data.refreshToken,
        // Keep the impersonation snapshot of the original tokens in sync so
        // revoke-impersonation restores tokens that are still valid.
        impersonation: current.impersonation
            ? { ...current.impersonation, originalAccessToken: data.token, originalRefreshToken: data.refreshToken }
            : undefined,
    };
    await setSession(updated);
    return updated;
}

/**
 * Rotates the session's refresh token via the gateway and reseals the cookie.
 * Returns the updated session, or null (with the cookie cleared) when the
 * gateway rejects the rotation.
 */
export async function refreshSession(session: SessionPayload): Promise<SessionPayload | null> {
    inFlight ??= rotate(session).finally(() => {
        inFlight = null;
    });
    return inFlight;
}
