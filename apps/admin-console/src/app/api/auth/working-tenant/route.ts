import { toSafeSession } from '@/server/safe-user';
import { getSession, isElevated, setSession } from '@/server/session';

/**
 * Working-tenant selection for the elevated cross-tenant set. The proxy sends
 * the stored id as X-Tenant-Id on every request; tenant-bound users have no
 * business here (the gateway would 400 on a mismatching header anyway).
 */
export async function POST(request: Request): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    if (!isElevated(session.user)) {
        return Response.json({ message: 'Only elevated users can select a working tenant' }, { status: 403 });
    }

    let tenantId: unknown;
    try {
        ({ tenantId } = (await request.json()) as { tenantId?: unknown });
    } catch {
        return Response.json({ message: 'Invalid request body' }, { status: 400 });
    }
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
        return Response.json({ message: 'tenantId is required' }, { status: 400 });
    }

    const updated = { ...session, workingTenantId: tenantId };
    await setSession(updated);
    return Response.json(toSafeSession(updated));
}

export async function DELETE(): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    if (!isElevated(session.user)) {
        return Response.json({ message: 'Only elevated users can select a working tenant' }, { status: 403 });
    }
    const updated = { ...session, workingTenantId: undefined };
    await setSession(updated);
    return Response.json(toSafeSession(updated));
}
