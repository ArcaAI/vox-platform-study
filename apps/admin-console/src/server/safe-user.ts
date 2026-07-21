import 'server-only';
import { isElevated, type SessionPayload } from '@/server/session';

/**
 * The client-visible session projection. Tokens NEVER leave the BFF; the
 * browser only learns who is signed in and which scope is active.
 */
export interface SafeSession {
    user: {
        id: string;
        username: string;
        email: string;
        roles: string[];
        /** Home tenant of a tenant-bound user (null for unscoped global admins). Non-secret. */
        tenantId: string | null;
    };
    isElevated: boolean;
    workingTenantId: string | null;
    workingTenantName: string | null;
    impersonatingUserId: string | null;
    impersonatingUsername: string | null;
    /**
     * The identity screens should render/authorize against: the impersonated
     * target while impersonating, otherwise the operator's own `user`.
     * `user`/`isElevated` above stay operator-only — they drive the
     * persona-control chrome (site header, "Impersonating" banner), which must
     * keep showing the real operator.
     */
    effectiveUser: {
        id: string;
        username: string;
        email: string;
        roles: string[];
        tenantId: string | null;
        departmentId: string | null;
    };
    effectiveIsElevated: boolean;
    /** Tenant scope for the effective identity: the target's tenant while
     * impersonating, else the operator's own working-tenant pick. */
    effectiveTenantId: string | null;
}

export function toSafeSession(session: SessionPayload): SafeSession {
    const { id, username, email, roles, tenantId } = session.user;
    const { impersonation } = session;

    const effectiveUser = impersonation
        ? {
              id: impersonation.targetUserId,
              username: impersonation.targetUsername ?? impersonation.targetUserId,
              email: impersonation.targetEmail ?? '',
              roles: impersonation.targetRoles ?? [],
              tenantId: impersonation.targetTenantId ?? null,
              departmentId: impersonation.targetDepartmentId ?? null,
          }
        : { id, username, email, roles, tenantId: tenantId ?? null, departmentId: null };

    return {
        user: { id, username, email, roles, tenantId: tenantId ?? null },
        isElevated: isElevated(session.user),
        workingTenantId: session.workingTenantId ?? null,
        workingTenantName: session.workingTenantName ?? null,
        impersonatingUserId: impersonation?.targetUserId ?? null,
        impersonatingUsername: impersonation?.targetUsername ?? null,
        effectiveUser,
        effectiveIsElevated: isElevated({ roles: effectiveUser.roles }),
        effectiveTenantId: impersonation ? (impersonation.targetTenantId ?? null) : (session.workingTenantId ?? null),
    };
}
