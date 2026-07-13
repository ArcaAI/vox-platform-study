import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';
import { setSession, type SessionPayload } from '@/server/session';

interface GatewaySsoCallbackResponse {
    user: {
        id: string;
        username: string;
        email: string;
        roles: string[];
        permissions: string[];
        tenantId?: string;
    };
    token: string;
    refreshToken: string;
}

/**
 * BFF SSO callback: the browser lands here directly from the IdP's redirect
 * (?code&state). Forwards both to the gateway, seals the result into the
 * session cookie exactly like /api/auth/login, then redirects into the app.
 * A verification failure (expired state, PKCE/nonce mismatch, revoked
 * membership) redirects back to /login with a user-facing message — never a
 * raw JSON error, since this is a top-level browser navigation, not a fetch.
 */
export async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
        return Response.redirect(new URL('/login?error=Missing+SSO+callback+parameters', request.url));
    }

    const gatewayResponse = await fetch(gatewayUrl('auth/sso/callback', `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`), {
        method: 'GET',
        headers: { ...clientUserAgentHeader(request) },
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!gatewayResponse.ok) {
        const message = await gatewayErrorMessage(gatewayResponse, 'Single sign-on failed');
        return Response.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, request.url));
    }

    const data = (await gatewayResponse.json()) as GatewaySsoCallbackResponse;
    const session: SessionPayload = {
        accessToken: data.token,
        refreshToken: data.refreshToken,
        user: {
            id: data.user.id,
            username: data.user.username,
            email: data.user.email,
            roles: data.user.roles,
            ...(data.user.tenantId ? { tenantId: data.user.tenantId } : {}),
        },
    };
    await setSession(session);

    return Response.redirect(new URL('/dashboard', request.url));
}
