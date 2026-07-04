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
    };
    isElevated: boolean;
    workingTenantId: string | null;
    impersonatingUserId: string | null;
}

export function toSafeSession(session: SessionPayload): SafeSession {
    const { id, username, email, roles } = session.user;
    return {
        user: { id, username, email, roles },
        isElevated: isElevated(session.user),
        workingTenantId: session.workingTenantId ?? null,
        impersonatingUserId: session.impersonation?.targetUserId ?? null,
    };
}
