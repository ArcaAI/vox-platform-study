import 'server-only';
import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { cookies } from 'next/headers';
import { serverEnv } from '@/config/env';
import { isElevated as rolesAreElevated } from '@/shared/auth/ability';
import { SESSION_COOKIE_NAME } from '@/shared/auth/session-cookie';

export { SESSION_COOKIE_NAME };

export interface SessionUser {
    id: string;
    username: string;
    email: string;
    roles: string[];
    permissions?: string[];
}

export interface ImpersonationState {
    /** Short-lived (~15m) token acting as the target user. */
    accessToken: string;
    originalAccessToken: string;
    originalRefreshToken: string;
    targetUserId: string;
}

export interface SessionPayload {
    accessToken: string;
    refreshToken: string;
    user: SessionUser;
    /** Elevated users only: tenant scope sent as X-Tenant-Id by the proxy. */
    workingTenantId?: string;
    impersonation?: ImpersonationState;
}

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** 32-byte AES key for dir+A256GCM, derived from ADMIN_SESSION_SECRET. */
function sessionKey(): Uint8Array {
    return new Uint8Array(createHash('sha256').update(serverEnv().ADMIN_SESSION_SECRET).digest());
}

/** Seals the payload into a compact JWE (the cookie value). */
export async function sealSession(payload: SessionPayload): Promise<string> {
    return new EncryptJWT({ session: payload })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
        .encrypt(sessionKey());
}

/** Returns the payload, or null for missing/tampered/expired tokens. */
export async function unsealSession(token: string | undefined): Promise<SessionPayload | null> {
    if (!token) return null;
    try {
        const { payload } = await jwtDecrypt(token, sessionKey());
        return (payload.session as SessionPayload | undefined) ?? null;
    } catch {
        return null;
    }
}

export async function getSession(): Promise<SessionPayload | null> {
    const cookieStore = await cookies();
    return unsealSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function setSession(payload: SessionPayload): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, await sealSession(payload), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
    });
}

export async function clearSession(): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE_NAME);
}

/** SUPER_ADMIN / GLOBAL_ADMIN — the elevated cross-tenant set. */
export function isElevated(user: Pick<SessionUser, 'roles'> | null | undefined): boolean {
    return rolesAreElevated(user?.roles);
}
