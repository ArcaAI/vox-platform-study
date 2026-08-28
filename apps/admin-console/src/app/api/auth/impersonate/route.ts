import { isTenantAdmin } from '@/shared/auth/ability';
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
  /** Set by the super-admin `admin/users/:id/impersonate` endpoint only; the legacy
   *  tenant-admin `auth/impersonate` route leaves these undefined. */
  expiresAt?: string;
  expiresInSeconds?: number;
}

/**
 * Starts impersonation.
 *
 * D-25: two gateway routes back this, chosen by the caller's role —
 * - SUPER_ADMIN: `POST /admin/users/:id/impersonate` (time-boxed, audited, cross-tenant;
 *   `AdminImpersonationController`).
 * - TENANT_ADMIN: `POST /auth/impersonate` (the legacy route) — own-tenant only. That
 *   restriction is enforced BY THE GATEWAY (`auth.controller.ts#impersonate`), not
 *   re-implemented here: this BFF only forwards to the endpoint that already has it, and a
 *   403 (or any other gateway error) passes straight through to the caller unchanged.
 *
 * The minted act-as token replaces the bearer on proxied requests while the original token
 * pair is kept for restoration.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return Response.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const elevated = isElevated(session.user);
  const tenantAdmin = isTenantAdmin(session.user.roles);
  if (!elevated && !tenantAdmin) {
    return Response.json({ message: 'Impersonation requires an elevated or tenant admin user' }, { status: 403 });
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

  // The two gateway routes take the target id on different sides of the wire: the admin
  // endpoint takes it in the PATH (no `targetUserId` in the body), the legacy route takes it
  // IN the body as `targetUserId`.
  const gatewayPath = elevated ? `admin/users/${encodeURIComponent(body.userId)}/impersonate` : 'auth/impersonate';
  const gatewayBody = elevated
    ? { ...(body.targetTenantId ? { targetTenantId: body.targetTenantId } : {}), ...(body.reason ? { reason: body.reason } : {}) }
    : { targetUserId: body.userId, ...(body.targetTenantId ? { targetTenantId: body.targetTenantId } : {}) };

  const gatewayResponse = await fetch(gatewayUrl(gatewayPath), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      ...clientUserAgentHeader(request),
    },
    body: JSON.stringify(gatewayBody),
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
