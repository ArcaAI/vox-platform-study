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
    roles: ['SUPER_ADMIN'],
  },
};

const tenantAdminSession: SessionPayload = {
  accessToken: 'tenant-admin-access',
  refreshToken: 'tenant-admin-refresh',
  user: {
    id: 'tenant-admin-1',
    username: 'ted_tenant_admin',
    email: 'ted@example.com',
    roles: ['TENANT_ADMIN'],
    tenantId: 'tenant-1',
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

interface RecordedFetchCall {
  url: string;
  body: unknown;
}

/** Stubs `fetch` and records the URL + parsed JSON body of every call the route makes. */
function installFetchSpy(handler: () => Response | Promise<Response>): RecordedFetchCall[] {
  const calls: RecordedFetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return handler();
    }),
  );
  return calls;
}

beforeEach(() => {
  cookieJar.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/impersonate — SUPER_ADMIN (cross-tenant, time-boxed)', () => {
  it('persists the target user email, roles, tenantId and departmentId into session.impersonation', async () => {
    await seedSession(operatorSession);
    installFetchSpy(() =>
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
    installFetchSpy(() =>
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

  it('routes through the super-admin, time-boxed admin/users/:id/impersonate endpoint', async () => {
    await seedSession(operatorSession);
    const calls = installFetchSpy(() =>
      Response.json({
        user: { id: 'doctor2-id', username: 'doctor2', email: 'doctor2@example.com', roles: ['DOCTOR'], permissions: [], tenantId: 'tenant-9' },
        token: 't',
        impersonatedBy: 'admin-1',
      }),
    );

    await POST(impersonateRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('admin/users/doctor2-id/impersonate');
    // The admin endpoint's request DTO takes no `targetUserId` — the id travels in the path.
    expect(calls[0]?.body).toEqual({});
  });
});

describe('POST /api/auth/impersonate — TENANT_ADMIN (D-25, own-tenant via the legacy route)', () => {
  it('routes through the legacy auth/impersonate endpoint with targetUserId in the body', async () => {
    await seedSession(tenantAdminSession);
    const calls = installFetchSpy(() =>
      Response.json({
        user: { id: 'doctor9-id', username: 'doctor9', email: 'doctor9@example.com', roles: ['DOCTOR'], permissions: [], tenantId: 'tenant-1' },
        token: 'impersonation-token-3',
        impersonatedBy: 'tenant-admin-1',
        // The legacy route leaves these undefined (only the admin endpoint sets them) —
        // asserting that here catches a BFF that assumes they are always present.
      }),
    );

    const response = await POST(impersonateRequest({ userId: 'doctor9-id' }));
    expect(response.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('auth/impersonate');
    expect(calls[0]?.url).not.toContain('admin/users');
    expect(calls[0]?.body).toEqual({ targetUserId: 'doctor9-id' });

    const session = await getSession();
    expect(session?.impersonation).toMatchObject({
      accessToken: 'impersonation-token-3',
      targetUserId: 'doctor9-id',
      targetUsername: 'doctor9',
      targetTenantId: 'tenant-1',
    });
  });

  it('does not re-implement the own-tenant check — a gateway 403 (cross-tenant target) passes through unchanged', async () => {
    await seedSession(tenantAdminSession);
    installFetchSpy(() => Response.json({ message: 'Tenant admin cannot impersonate users outside their own tenant' }, { status: 403 }));

    const response = await POST(impersonateRequest({ userId: 'other-tenant-doctor' }));
    expect(response.status).toBe(403);

    const session = await getSession();
    expect(session?.impersonation).toBeUndefined();
  });
});

describe('POST /api/auth/impersonate — callers with neither role', () => {
  it('rejects a caller who is neither SUPER_ADMIN nor TENANT_ADMIN', async () => {
    await seedSession({
      ...operatorSession,
      user: { ...operatorSession.user, roles: ['DOCTOR'] },
    });
    const response = await POST(impersonateRequest());
    expect(response.status).toBe(403);
  });
});
