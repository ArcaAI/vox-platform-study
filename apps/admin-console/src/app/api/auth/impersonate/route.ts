import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';
import { toSafeSession } from '@/server/safe-user';
import { getSession, isElevated, setSession } from '@/server/session';

interface ImpersonateRequestBody {
  userId?: string;
  targetTenantId?: string;
  reason?: string;
}

interface GatewayImpersonateResponse {
  user: {
    id: string;
    username: string;
    email: string;
    roles: string[];
    permissions: string[];
    tenantId: string;
    /** Target's primary department in the impersonation tenant; absent if none active. */
    departmentId?: string;
  };
  token: string;
  impersonatedBy: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * Starts impersonation (super-admin only; POST /admin/users/:id/impersonate).
 * The minted act-as token replaces the bearer on proxied requests while the
 * original token pair is kept for restoration. No UI consumes this yet.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return Response.json({ message: 'Unauthorized' }, { status: 401 });
  }
  if (!isElevated(session.user)) {
    return Response.json({ message: 'Impersonation requires an elevated user' }, { status: 403 });
  }
  if (session.impersonation) {
    return Response.json({ message: 'Already impersonating; revoke first' }, { status: 400 });
  }

  let body: ImpersonateRequestBody;
  try {
    body = (await request.json()) as ImpersonateRequestBody;
  } catch {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }
  if (!body.userId) {
    return Response.json({ message: 'userId is required' }, { status: 400 });
  }

  const gatewayResponse = await fetch(gatewayUrl(`admin/users/${encodeURIComponent(body.userId)}/impersonate`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      ...clientUserAgentHeader(request),
    },
    body: JSON.stringify({
      ...(body.targetTenantId ? { targetTenantId: body.targetTenantId } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    }),
    cache: 'no-store',
    redirect: 'manual',
  });

  if (!gatewayResponse.ok) {
    const message = await gatewayErrorMessage(gatewayResponse, 'Impersonation failed');
    return Response.json({ message }, { status: gatewayResponse.status });
  }

  const data = (await gatewayResponse.json()) as GatewayImpersonateResponse;
  const updated = {
    ...session,
    impersonation: {
      accessToken: data.token,
      originalAccessToken: session.accessToken,
      originalRefreshToken: session.refreshToken,
      targetUserId: data.user.id,
      targetUsername: data.user.username,
      // The full target identity, so the client can
      // project an effective session distinct from the operator's own.
      targetEmail: data.user.email,
      targetRoles: data.user.roles,
      targetTenantId: data.user.tenantId,
      targetDepartmentId: data.user.departmentId,
    },
  };
  await setSession(updated);

  return Response.json({
    ...toSafeSession(updated),
    impersonation: { targetUserId: data.user.id, targetUsername: data.user.username, expiresAt: data.expiresAt },
  });
}
