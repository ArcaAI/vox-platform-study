import { gatewayErrorMessage, gatewayUrl } from '@/server/gateway';
import { toSafeSession } from '@/server/safe-user';
import { setSession, type SessionPayload } from '@/server/session';

interface LoginRequestBody {
    username?: string;
    password?: string;
    tenantKey?: string;
}

interface GatewayLoginResponse {
    user: {
        id: string;
        username: string;
        email: string;
        roles: string[];
        permissions: string[];
        tenantId?: string;
        tenantKey?: string;
    };
    token: string;
    refreshToken: string;
    passwordExpired?: boolean;
}

/**
 * BFF login: exchanges credentials with the gateway and seals the tokens
 * into the httpOnly session cookie. The response carries only the safe user
 * projection — tokens never reach the browser.
 */
export async function POST(request: Request): Promise<Response> {
    let body: LoginRequestBody;
    try {
        body = (await request.json()) as LoginRequestBody;
    } catch {
        return Response.json({ message: 'Invalid request body' }, { status: 400 });
    }
    if (!body.username || !body.password) {
        return Response.json({ message: 'Username and password are required' }, { status: 400 });
    }

    const gatewayResponse = await fetch(gatewayUrl('auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            username: body.username,
            password: body.password,
            ...(body.tenantKey ? { tenantKey: body.tenantKey } : {}),
        }),
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!gatewayResponse.ok) {
        const message = await gatewayErrorMessage(gatewayResponse, 'Login failed');
        return Response.json({ message }, { status: gatewayResponse.status });
    }

    const data = (await gatewayResponse.json()) as GatewayLoginResponse;
    const session: SessionPayload = {
        accessToken: data.token,
        refreshToken: data.refreshToken,
        user: {
            id: data.user.id,
            username: data.user.username,
            email: data.user.email,
            roles: data.user.roles,
        },
    };
    await setSession(session);

    return Response.json({
        ...toSafeSession(session),
        ...(data.passwordExpired ? { passwordExpired: true } : {}),
    });
}
