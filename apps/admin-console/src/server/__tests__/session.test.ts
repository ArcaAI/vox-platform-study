import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => {
    const jar = new Map<string, { name: string; value: string; [key: string]: unknown }>();
    return { cookieJar: jar };
});

vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => cookieJar.get(name),
        set: (name: string, value: string, options?: Record<string, unknown>) => {
            cookieJar.set(name, { name, value, ...(options ?? {}) });
        },
        delete: (name: string) => {
            cookieJar.delete(name);
        },
        has: (name: string) => cookieJar.has(name),
    }),
}));

import { SESSION_COOKIE_NAME, clearSession, getSession, isElevated, sealSession, setSession, unsealSession, type SessionPayload } from '../session';

const payload: SessionPayload = {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    user: {
        id: 'user-1',
        username: 'admin',
        email: 'admin@example.com',
        roles: ['SUPER_ADMIN'],
        permissions: ['*'],
    },
};

beforeEach(() => {
    cookieJar.clear();
});

describe('sealSession / unsealSession', () => {
    it('round-trips a session payload through the encrypted JWE', async () => {
        const token = await sealSession(payload);
        expect(token).toBeTypeOf('string');
        // JWE compact serialization: five dot-separated segments, opaque content.
        expect(token.split('.')).toHaveLength(5);
        expect(token).not.toContain('access-token-1');

        const unsealed = await unsealSession(token);
        expect(unsealed).toEqual(payload);
    });

    it('round-trips workingTenantId and impersonation state', async () => {
        const full: SessionPayload = {
            ...payload,
            workingTenantId: '50000000-0000-0000-0000-000000000000',
            impersonation: {
                accessToken: 'impersonation-token',
                originalAccessToken: 'access-token-1',
                originalRefreshToken: 'refresh-token-1',
                targetUserId: 'user-2',
            },
        };
        const unsealed = await unsealSession(await sealSession(full));
        expect(unsealed).toEqual(full);
    });

    it('rejects a tampered token', async () => {
        const token = await sealSession(payload);
        const segments = token.split('.');
        // Flip a character inside the ciphertext segment.
        const cipher = segments[3];
        segments[3] = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1);
        expect(await unsealSession(segments.join('.'))).toBeNull();
    });

    it('rejects garbage input', async () => {
        expect(await unsealSession('not-a-jwe')).toBeNull();
    });
});

describe('cookie helpers', () => {
    it('getSession returns null when no cookie is set', async () => {
        expect(await getSession()).toBeNull();
    });

    it('setSession seals the payload into a hardened cookie and getSession reads it back', async () => {
        await setSession(payload);

        const cookie = cookieJar.get(SESSION_COOKIE_NAME);
        expect(cookie).toBeDefined();
        expect(cookie).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7,
        });
        // Development runs without TLS; production must set secure cookies.
        expect(cookie?.secure).toBe(false);

        expect(await getSession()).toEqual(payload);
    });

    it('clearSession drops the cookie', async () => {
        await setSession(payload);
        await clearSession();
        expect(await getSession()).toBeNull();
        const cookie = cookieJar.get(SESSION_COOKIE_NAME);
        expect(cookie?.value ?? '').toBe('');
    });
});

describe('isElevated', () => {
    it('is true for SUPER_ADMIN and GLOBAL_ADMIN', () => {
        expect(isElevated({ roles: ['SUPER_ADMIN'] })).toBe(true);
        expect(isElevated({ roles: ['GLOBAL_ADMIN'] })).toBe(true);
        expect(isElevated({ roles: ['TENANT_ADMIN', 'GLOBAL_ADMIN'] })).toBe(true);
    });

    it('is false for tenant-bound roles and empty input', () => {
        expect(isElevated({ roles: ['TENANT_ADMIN'] })).toBe(false);
        expect(isElevated({ roles: [] })).toBe(false);
        expect(isElevated(null)).toBe(false);
        expect(isElevated(undefined)).toBe(false);
    });
});
