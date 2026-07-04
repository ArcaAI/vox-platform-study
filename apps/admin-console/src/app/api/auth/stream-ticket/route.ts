import { activeAccessToken, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';
import { getSession, isElevated } from '@/server/session';

/**
 * Mints a single-use (~30s) scope-bound ticket via the gateway. The browser
 * then connects DIRECTLY to the gateway SSE/WS endpoint with ?ticket=... —
 * streams never traverse the BFF proxy.
 */
export async function POST(request: Request): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }

    let body: string;
    try {
        body = JSON.stringify(await request.json());
    } catch {
        return Response.json({ message: 'Invalid request body' }, { status: 400 });
    }

    const headers = new Headers({
        authorization: `Bearer ${activeAccessToken(session)}`,
        'content-type': 'application/json',
    });
    // The ticket inherits the CLS tenant, so the working-tenant scope must
    // ride along exactly as it does on proxied requests.
    if (session.workingTenantId && isElevated(session.user)) {
        headers.set('x-tenant-id', session.workingTenantId);
    }

    const gatewayResponse = await fetch(gatewayUrl('auth/stream-ticket'), {
        method: 'POST',
        headers,
        body,
        cache: 'no-store',
        redirect: 'manual',
    });

    if (!gatewayResponse.ok) {
        const message = await gatewayErrorMessage(gatewayResponse, 'Failed to issue stream ticket');
        return Response.json({ message }, { status: gatewayResponse.status });
    }
    return Response.json(await gatewayResponse.json());
}
