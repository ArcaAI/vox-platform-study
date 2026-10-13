import { activeAccessToken, gatewayUrl } from '@/server/gateway';
import { toSafeSession } from '@/server/safe-user';
import { getSession, isElevated, setSession } from '@/server/session';

/** The tenant's display name via the gateway, or undefined when it cannot be resolved. */
async function resolveTenantName(tenantId: string, accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(gatewayUrl(`admin/tenants/${encodeURIComponent(tenantId)}`), {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      redirect: 'manual',
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined;
  } catch {
    return undefined;
  }
}

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
  let tenantName: unknown;
  try {
    ({ tenantId, tenantName } = (await request.json()) as { tenantId?: unknown; tenantName?: unknown });
  } catch {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return Response.json({ message: 'tenantId is required' }, { status: 400 });
  }

  // The sealed name lets the banner paint the real tenant on a cold load; a body that omits it
  // is resolved here, once, instead of by every client after its tenants query settles.
  const resolvedName =
    typeof tenantName === 'string' && tenantName.length > 0 ? tenantName : await resolveTenantName(tenantId, activeAccessToken(session));
  const updated = { ...session, workingTenantId: tenantId, workingTenantName: resolvedName };
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
  const updated = { ...session, workingTenantId: undefined, workingTenantName: undefined };
  await setSession(updated);
  return Response.json(toSafeSession(updated));
}
