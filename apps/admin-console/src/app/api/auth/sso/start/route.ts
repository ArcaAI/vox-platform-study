import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';

interface SsoStartRequestBody {
    email?: string;
    tenantKey?: string;
}

interface GatewaySsoStartResponse {
    authorizeUrl: string;
}

/**
 * BFF SSO start: resolves the tenant's IdP (HRD by email, or an explicit
 * tenantKey) via the gateway and returns its authorize URL. No session exists
 * yet — this call is pre-auth, same posture as /api/auth/login.
 */
export async function POST(request: Request): Promise<Response> {
    let body: SsoStartRequestBody;
    try {
        body = (await request.json()) as SsoStartRequestBody;
    } catch {
        return Response.json({ message: 'Invalid request body' }, { status: 400 });
    }
    if (!body.email && !body.tenantKey) {
        return Response.json({ message: 'Email or tenant key is required' }, { status: 400 });
    }

    const gatewayResponse = await fetch(gatewayUrl('auth/sso/start'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...clientUserAgentHeader(request) },
        body: JSON.stringify({
            ...(body.email ? { email: body.email } : {}),
            ...(body.tenantKey ? { tenantKey: body.tenantKey } : {}),
        }),
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!gatewayResponse.ok) {
        const message = await gatewayErrorMessage(gatewayResponse, 'Could not start single sign-on');
        return Response.json({ message }, { status: gatewayResponse.status });
    }

    const data = (await gatewayResponse.json()) as GatewaySsoStartResponse;
    return Response.json({ authorizeUrl: data.authorizeUrl });
}
