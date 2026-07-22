/**
 * Token revocation convergence + HIPAA failed-auth audit (E2E)
 *
 * Pins the three invariants the unit tests can only mock, against a running
 * API with real Redis and a real audit table:
 *
 *   A. **Revocation actually enforced** — after `/auth/logout`, replaying the
 *      access token is refused. This is the invariant that was silently
 *      disabled on the `IAuthService.isTokenRevoked` path (a stub returning
 *      `false`) before A1 pointed it at `JwtRevocationService`.
 *
 *   B. **Deactivation kills LIVE tokens** (A4) — disabling a user stamps a
 *      per-user not-before, so an access token minted BEFORE the disable stops
 *      working immediately instead of surviving until its own `exp`. Before
 *      A4, `resourceStatus` only gated the NEXT login/refresh.
 *
 *   C. **Failed attempts are queryable** (B1) — a rejected login writes an
 *      AuditLog row with `success: false` and a machine-readable reason, so
 *      credential stuffing and post-termination access attempts are
 *      reviewable per HIPAA §164.312(b). Previously success-only.
 *
 * TEST DATA MANAGEMENT:
 *   - A and C use seeded users read-only (transient Redis writes + audit rows).
 *   - B CREATES its own throwaway user, disables it, and soft-deletes it in
 *     teardown. It must never disable a seeded user — every other e2e spec
 *     logs in as those.
 *
 * NOTE: requires a running API (`pnpm test:api:up`) with Redis reachable.
 * Revocation degrades open by design when Redis is down (see A3), so a
 * Redis-less run would report FALSE PASSES on A/B.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser, DEFAULT_TENANT_KEY } from '../../../../tests/helpers';

interface DecodedJwt {
  id: string;
  jti: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

function decodeJwtPayload(token: string): DecodedJwt {
  const parts = token.split('.');
  expect(parts.length, 'token must be a well-formed JWT').toBe(3);
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as DecodedJwt;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A global admin has no implicit working tenant, so tenant-scoped writes
 * (role/department assignment) need an explicit `X-Tenant-Id` selection —
 * the same header the admin console sends.
 */
const authAsTenant = (token: string, tenantId: string) => ({
  Authorization: `Bearer ${token}`,
  'X-Tenant-Id': tenantId,
});

// Seeded ids (packages/database/src/prisma/db_main/seed/00-constants.ts).
// Inlined rather than imported so this spec has no build-order dependency on
// the database package's seed module.
const SEED_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SEED_DOCTOR_ROLE_ID = '00000000-0000-0000-0000-000000000010';
const SEED_GEN_DEPARTMENT_ID = '70000000-0000-0000-0000-000000000001';

/** A user id that is unique per run so parallel/retried runs never collide. */
function throwawayUsername(): string {
  return `task541_probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'super admin login failed — is the API seeded?').toBeTruthy();
  return login!.token;
}

test.describe('A — per-token revocation is enforced end-to-end', () => {
  test('a logged-out access token is refused on the next request', async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed').toBeTruthy();
    const token = login!.token;

    // Sanity: the token works BEFORE logout, so a later 401 is attributable
    // to revocation rather than to a malformed token.
    const before = await request.get('/api/v1/auth/me', { headers: auth(token) });
    expect(before.status(), 'token should work before logout').toBe(200);

    const logout = await request.post('/api/v1/auth/logout', { headers: auth(token) });
    expect(logout.status()).toBe(200);

    const after = await request.get('/api/v1/auth/me', { headers: auth(token) });
    expect(after.status(), 'revoked jti must be refused (A1: the stub used to accept it)').toBe(401);
  });
});

test.describe('B — disabling a user kills tokens already in the wild', () => {
  let createdUserId: string | null = null;

  test.afterEach(async ({ request }) => {
    if (!createdUserId) return;
    const token = await adminToken(request);
    await request.delete(`/api/v1/admin/users/${createdUserId}`, { headers: authAsTenant(token, SEED_TENANT_ID) });
    createdUserId = null;
  });

  test('an access token minted BEFORE the disable stops working immediately', async ({ request }) => {
    const admin = await adminToken(request);
    const username = throwawayUsername();
    const password = 'ProbePassword123!';

    // Login enforces FULL membership: an enabled role AND
    // an enabled department in the target tenant. A bare user row cannot log
    // in, so the probe is created through the atomic create-with-membership
    // branch using the seeded DOCTOR role + GEN department.
    const created = await request.post('/api/v1/admin/users', {
      headers: authAsTenant(admin, SEED_TENANT_ID),
      data: {
        username,
        password,
        email: `${username}@example.com`,
        roleId: SEED_DOCTOR_ROLE_ID,
        departmentId: SEED_GEN_DEPARTMENT_ID,
      },
    });
    expect(created.status(), `probe user creation failed: ${await created.text()}`).toBeLessThan(300);
    createdUserId = (await created.json())?.id ?? null;
    expect(createdUserId, 'probe user id missing from create response').toBeTruthy();

    const login = await loginUser(request, username, password, DEFAULT_TENANT_KEY);
    expect(login, 'probe user login failed').toBeTruthy();
    const probeToken = login!.token;

    // The not-before comparison is against `iat`, so pin that the token
    // really does predate the disable we are about to perform.
    const issuedAt = decodeJwtPayload(probeToken).iat;
    expect(issuedAt, 'probe token must carry an iat claim').toBeTruthy();

    const before = await request.get('/api/v1/auth/me', { headers: auth(probeToken) });
    expect(before.status(), 'probe token should work before disable').toBe(200);

    const disabled = await request.patch(`/api/v1/admin/users/${createdUserId}`, {
      headers: authAsTenant(admin, SEED_TENANT_ID),
      data: { resourceStatus: 'DISABLED' },
    });
    expect(disabled.status(), 'disabling the probe user failed').toBeLessThan(300);

    const after = await request.get('/api/v1/auth/me', { headers: auth(probeToken) });
    expect(after.status(), 'A4: a disabled user’s live token must die with the row, not at its own exp').toBe(401);
  });
});

test.describe('C — failed authentication is auditable', () => {
  test('a rejected login writes a success=false AuditLog row carrying the reason', async ({ request }) => {
    const attempted = throwawayUsername();

    const failed = await request.post('/api/v1/auth/login', {
      data: { username: attempted, password: 'definitely-wrong', tenantKey: DEFAULT_TENANT_KEY },
    });
    expect(failed.status(), 'the probe login must be rejected').toBe(401);

    const token = await adminToken(request);

    // The write is synchronous within the request lifecycle, but poll briefly
    // so a slow audit write cannot flake the assertion.
    let row: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10 && !row; attempt++) {
      const res = await request.get('/api/v1/admin/audit-logs?limit=50&page=1', { headers: auth(token) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      const items: Record<string, unknown>[] = body?.data ?? body?.items ?? [];
      row = items.find((r) => {
        if (r.eventType !== 'AUTHENTICATION' || r.success !== false) return false;
        return JSON.stringify(r.data ?? {}).includes(attempted);
      });
      if (!row) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(row, 'B1: a rejected login must leave a queryable audit row').toBeTruthy();
    expect(row!.action).toBe('LOGIN');
    expect(row!.success).toBe(false);
    expect(JSON.stringify(row!.data)).toContain('unknown_or_disabled_user');
  });

  test('the audit row never contains the attempted password', async ({ request }) => {
    const attempted = throwawayUsername();
    const secret = `Sup3rSecret-${Date.now()}`;

    const failed = await request.post('/api/v1/auth/login', {
      data: { username: attempted, password: secret, tenantKey: DEFAULT_TENANT_KEY },
    });
    expect(failed.status()).toBe(401);

    const token = await adminToken(request);
    const res = await request.get('/api/v1/admin/audit-logs?limit=50&page=1', { headers: auth(token) });
    expect(res.status()).toBe(200);

    expect(JSON.stringify(await res.json()), 'a credential must never reach the audit table').not.toContain(secret);
  });

  test('a SUCCESSFUL login still writes only the success row (no false-failure noise)', async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login).toBeTruthy();

    const token = await adminToken(request);
    const res = await request.get('/api/v1/admin/audit-logs?limit=20&page=1', { headers: auth(token) });
    expect(res.status()).toBe(200);

    const body = await res.json();
    const items: Record<string, unknown>[] = body?.data ?? body?.items ?? [];
    const recentFailuresForDoctor = items.filter(
      (r) => r.eventType === 'AUTHENTICATION' && r.success === false && r.responsibleUserId === SEEDED_USERS.doctor.id,
    );

    expect(recentFailuresForDoctor, 'a successful login must not emit a failure row').toHaveLength(0);
  });
});
