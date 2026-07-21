import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';

interface VerifyRequestBody {
    token?: string;
}

/**
 * BFF verify-email: pure passthrough — the gateway response
 * carries no tokens (verify does not auto-login), so there is nothing to
 * seal into the session cookie here.
 */
export async function POST(request: Request): Promise<Response> {
    let body: VerifyRequestBody;
    try {
        body = (await request.json()) as VerifyRequestBody;
    } catch {
        return Response.json({ message: 'Invalid request body' }, { status: 400 });
    }
    if (!body.token) {
        return Response.json({ message: 'Token is required' }, { status: 400 });
    }

    const gatewayResponse = await fetch(gatewayUrl('auth/register/verify'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...clientUserAgentHeader(request) },
        body: JSON.stringify({ token: body.token }),
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!gatewayResponse.ok) {
        const message = await gatewayErrorMessage(gatewayResponse, 'Verification failed');
        return Response.json({ message }, { status: gatewayResponse.status });
    }

    const data = await gatewayResponse.json();
    return Response.json(data, { status: gatewayResponse.status });
}
