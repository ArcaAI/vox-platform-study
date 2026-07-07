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
}

export function toSafeSession(session: SessionPayload): SafeSession {
    const { id, username, email, roles, tenantId } = session.user;
    return {
        user: { id, username, email, roles, tenantId: tenantId ?? null },
        isElevated: isElevated(session.user),
        workingTenantId: session.workingTenantId ?? null,
        workingTenantName: session.workingTenantName ?? null,
        impersonatingUserId: session.impersonation?.targetUserId ?? null,
        impersonatingUsername: session.impersonation?.targetUsername ?? null,
    };
}
