import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { POST } from '../route';
import { SESSION_COOKIE_NAME, getSession, sealSession, type SessionPayload } from '@/server/session';

const operatorSession: SessionPayload = {
  accessToken: 'operator-access',
  refreshToken: 'operator-refresh',
  user: {
    id: 'admin-1',
    username: 'super_admin',
    email: 'super_admin@example.com',
    roles: ['GLOBAL_ADMIN'],
  },
};

async function seedSession(session: SessionPayload): Promise<void> {
  cookieJar.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: await sealSession(session) });
}

function impersonateRequest(body: Record<string, unknown> = { userId: 'doctor2-id' }): Request {
  return new Request('http://console.local/api/auth/impersonate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installFetchMock(handler: () => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

beforeEach(() => {
  cookieJar.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/impersonate — effective identity', () => {
  it('persists the target user email, roles, tenantId and departmentId into session.impersonation', async () => {
    await seedSession(operatorSession);
    installFetchMock(() =>
      Response.json({
        user: {
          id: 'doctor2-id',
          username: 'doctor2',
          email: 'doctor2@example.com',
          roles: ['DOCTOR'],
          permissions: ['read:own'],
          tenantId: '50000000-0000-0000-0000-000000000000',
          departmentId: 'dept-cardiology',
        },
        token: 'impersonation-token',
        impersonatedBy: 'admin-1',
        expiresAt: '2026-07-12T12:30:00.000Z',
        expiresInSeconds: 1800,
      }),
    );

    const response = await POST(impersonateRequest());
    expect(response.status).toBe(200);

    const session = await getSession();
    expect(session?.impersonation).toMatchObject({
      accessToken: 'impersonation-token',
      originalAccessToken: 'operator-access',
      originalRefreshToken: 'operator-refresh',
      targetUserId: 'doctor2-id',
      targetUsername: 'doctor2',
      targetEmail: 'doctor2@example.com',
      targetRoles: ['DOCTOR'],
      targetTenantId: '50000000-0000-0000-0000-000000000000',
      targetDepartmentId: 'dept-cardiology',
    });
  });

  it('tolerates a target with no active department (departmentId omitted, not crashed)', async () => {
    await seedSession(operatorSession);
    installFetchMock(() =>
      Response.json({
        user: {
          id: 'doctor3-id',
          username: 'doctor3',
          email: 'doctor3@example.com',
          roles: ['DOCTOR'],
          permissions: [],
          tenantId: '50000000-0000-0000-0000-000000000000',
          // departmentId intentionally absent.
        },
        token: 'impersonation-token-2',
        impersonatedBy: 'admin-1',
        expiresAt: '2026-07-12T12:30:00.000Z',
        expiresInSeconds: 1800,
      }),
    );

    const response = await POST(impersonateRequest());
    expect(response.status).toBe(200);

    const session = await getSession();
    expect(session?.impersonation?.targetDepartmentId).toBeUndefined();
    expect(session?.impersonation?.targetTenantId).toBe('50000000-0000-0000-0000-000000000000');
  });

  it('still requires an elevated caller (pre-existing guard, unaffected by the wider persisted state)', async () => {
    await seedSession({
      ...operatorSession,
      user: { ...operatorSession.user, roles: ['TENANT_ADMIN'] },
    });
    const response = await POST(impersonateRequest());
    expect(response.status).toBe(403);
  });
});
