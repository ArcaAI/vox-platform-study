/**
 * User impersonation (T5 "act-as"): live API contract.
 *
 * Real HTTP round-trips against the live dev stack
 * (`SKIP_DB_PRECHECK=true`, `API_URL=http://localhost:8868/api/v1`). Harness
 * mirrors task-400 (seeded users; throwaway targets; UPDATE-only fixtures —
 * never DELETE/TRUNCATE; throwaway users are soft-deleted via the API).
 *
 * Coverage:
 *   A. Mint + claims — super-admin `POST /admin/users/:id/impersonate` returns
 *      a time-boxed token whose claims carry BOTH the subject (target id/roles/
 *      tenant) AND the true actor (`impersonatedBy`), with `impersonate-` jti
 *      and a ~30m default expiry (clamped override honoured).
 *   B. Act-as — the token resolves auth context to the TARGET (`/auth/me`),
 *      reads tenant-scoped data, and a WRITE (PATCH /user/me/preferences)
 *      lands an audit row whose `metadata.impersonatedBy` records the actor
 *      (provenance threading through BaseService → SysEvent → AuditLog).
 *   C. Lifecycle audit — forced USER_IMPERSONATION_STARTED/ENDED rows
 *      (forceAuditLog posture) with reason/expiry.
 *   D. End + expiry — revoke kills the jti (401 afterwards); a short-TTL mint
 *      expires on its own (401 after exp).
 *   E. Safeguard matrix — non-super-admin callers 403 (doctor + tenant-admin),
 *      self 400, super-admin-tier target 400 (seeded GLOBAL_ADMIN), disabled
 *      target 400, unknown target 404, nested impersonation rejected on BOTH
 *      endpoints.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const UNIQUE = Date.now();

/** Seeded GLOBAL_ADMIN (00-constants SEED_USER_IDS) — super-admin-tier target. */
const GLOBAL_ADMIN_USER_ID = '70000000-0000-0000-0000-000000000006';

interface ImpersonateBody {
  user: { id: string; username: string; email?: string; roles: string[]; permissions: string[]; tenantId?: string };
  token: string;
  impersonatedBy: string;
  expiresAt?: string;
  expiresInSeconds?: number;
}

interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  responsibleUserId: string | null;
  tenantId: string;
  data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

let saToken: string;
let saUserId: string;

const impersonate = (request: APIRequestContext, targetId: string, body: Record<string, unknown> = {}, token = saToken) =>
  request.post(`/api/v1/admin/users/${targetId}/impersonate`, { headers: bearer(token), data: body });

/** Poll the (async, queue-backed) audit log until `predicate` matches a row. */
async function pollAuditRows(
  request: APIRequestContext,
  query: Record<string, string>,
  predicate: (row: AuditRow) => boolean,
  timeoutMs = 20_000,
): Promise<AuditRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ limit: '50', sort: 'createdAt:desc', ...query }).toString();
    const res = await request.get(`/api/v1/admin/audit-logs?${params}`, { headers: bearer(saToken) });
    if (res.status() === 200) {
      const rows = asArray<AuditRow>(await res.json());
      const hit = rows.find(predicate);
      if (hit) return hit;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

test.beforeAll(async ({ request }) => {
  const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
  expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
  saToken = sa!.token;
  saUserId = sa!.user.id;
});

// =============================================================================
// A — mint + claims
// =============================================================================
test.describe.serial('A — mint + claims', () => {
  test('A1 — super-admin mints a time-boxed token carrying subject AND actor claims', async ({ request }) => {
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { reason: `t401 A1 ${UNIQUE}` });
    expect(res.status(), 'super-admin mint → 200').toBe(200);
    const body = (await res.json()) as ImpersonateBody;

    // Response envelope: subject identity + actor + expiry.
    expect(body.user.id).toBe(SEEDED_USERS.doctor.id);
    expect(body.user.roles).toContain('DOCTOR');
    expect(body.user.tenantId, 'a resolved tenant travels with the session').toBeTruthy();
    expect(body.impersonatedBy).toBe(saUserId);
    expect(body.expiresAt, 'expiresAt returned').toBeTruthy();
    // Default TTL ≈ 30m (allow scheduler slack).
    expect(body.expiresInSeconds!).toBeGreaterThan(1700);
    expect(body.expiresInSeconds!).toBeLessThanOrEqual(1800);

    // Signed claims: subject resolves to the target; provenance to the actor.
    const claims = decodeClaims(body.token);
    expect(claims.id).toBe(SEEDED_USERS.doctor.id);
    expect(claims.impersonatedBy).toBe(saUserId);
    expect(claims.roles).toContain('DOCTOR');
    expect(claims.tenantId).toBe(body.user.tenantId);
    expect(String(claims.jti)).toMatch(/^impersonate-[0-9a-f]{32}$/);
    expect(claims.refreshable, 'impersonation tokens are never refreshable').toBeFalsy();

    // Non-refreshable: no refresh token anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/refreshToken/i);
  });

  test('A2 — expiresInSeconds override is honoured and clamped to the 10s floor', async ({ request }) => {
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { expiresInSeconds: 60 });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as ImpersonateBody;
    expect(body.expiresInSeconds!).toBeLessThanOrEqual(60);
    expect(body.expiresInSeconds!).toBeGreaterThan(50);

    const floor = await impersonate(request, SEEDED_USERS.doctor.id, { expiresInSeconds: 1 });
    expect(floor.status(), 'below-floor override → 400 (class-validator @Min(10))').toBe(400);
  });
});

// =============================================================================
// B — act-as + write provenance
// =============================================================================
test.describe.serial('B — act-as + write provenance', () => {
  let session: ImpersonateBody;

  test.beforeAll(async ({ request }) => {
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { reason: `t401 B ${UNIQUE}` });
    expect(res.status()).toBe(200);
    session = (await res.json()) as ImpersonateBody;
  });

  test('B1 — auth context resolves to the target (acts as the doctor)', async ({ request }) => {
    const me = await request.get('/api/v1/auth/me', { headers: bearer(session.token) });
    expect(me.status(), '/auth/me with impersonation token').toBe(200);
    const body = await me.json();
    expect(body.id ?? body.user?.id).toBe(SEEDED_USERS.doctor.id);
  });

  test('B2 — tenant-scoped read works as the target', async ({ request }) => {
    const prefs = await request.get('/api/v1/user/me/preferences', { headers: bearer(session.token) });
    expect(prefs.status(), 'target-scoped read → 200').toBe(200);
  });

  test('B3 — a write succeeds and its audit row carries the impersonator (metadata.impersonatedBy)', async ({ request }) => {
    const marker = `t401-provenance-${UNIQUE}`;
    const write = await request.patch('/api/v1/user/me/preferences', {
      headers: bearer(session.token),
      data: { custom: { t401Marker: marker } },
    });
    expect(write.status(), 'impersonated write → 200').toBe(200);

    // The CRUD row is attributed to the TARGET (responsibleUserId) while the
    // TRUE ACTOR is threaded into metadata by BaseService.broadcastSysEvent.
    const row = await pollAuditRows(
      request,
      { userId: SEEDED_USERS.doctor.id, resourceType: 'UserSettings' },
      (r) => r.metadata?.impersonatedBy === saUserId,
    );
    expect(row, 'audit row with metadata.impersonatedBy=<super-admin> for the doctor write').toBeTruthy();
    expect(row!.responsibleUserId).toBe(SEEDED_USERS.doctor.id);
    expect(row!.metadata!.impersonatedBy).toBe(saUserId);
  });
});

// =============================================================================
// C — lifecycle audit rows (forced)
// =============================================================================
test.describe.serial('C — forced lifecycle audit rows', () => {
  test('C1 — START row (actor, target, tenant, expiry, reason) and END row after revoke', async ({ request }) => {
    const reason = `t401 C1 lifecycle ${UNIQUE}`;
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { reason });
    expect(res.status()).toBe(200);
    const session = (await res.json()) as ImpersonateBody;

    const startRow = await pollAuditRows(
      request,
      { userId: saUserId, resourceType: 'User', action: 'READ' },
      (r) => r.data?.action === 'USER_IMPERSONATION_STARTED' && r.data?.reason === reason,
    );
    expect(startRow, 'forced USER_IMPERSONATION_STARTED row').toBeTruthy();
    expect(startRow!.responsibleUserId).toBe(saUserId);
    expect(startRow!.resourceId).toBe(SEEDED_USERS.doctor.id);
    expect(startRow!.data!.impersonatorUserId).toBe(saUserId);
    expect(startRow!.data!.targetUserId).toBe(SEEDED_USERS.doctor.id);
    expect(startRow!.data!.expiresAt, 'expiry recorded on the start row').toBeTruthy();
    expect(startRow!.tenantId, 'row attributed to the resolved impersonation tenant').toBe(session.user.tenantId);

    // End early (the auth module's existing revocation store = Redis jti).
    const revoke = await request.post('/api/v1/auth/revoke-impersonation', { headers: bearer(session.token) });
    expect(revoke.status(), 'revoke-impersonation with the impersonation token').toBe(200);

    const endRow = await pollAuditRows(
      request,
      { userId: saUserId, resourceType: 'User', action: 'READ' },
      (r) => r.data?.action === 'USER_IMPERSONATION_ENDED' && new Date(r.createdAt) >= new Date(startRow!.createdAt),
    );
    expect(endRow, 'forced USER_IMPERSONATION_ENDED row').toBeTruthy();
    expect(endRow!.data!.impersonatorUserId).toBe(saUserId);
    expect(endRow!.data!.targetUserId).toBe(SEEDED_USERS.doctor.id);

    // The revoked token is dead immediately.
    const after = await request.get('/api/v1/auth/me', { headers: bearer(session.token) });
    expect(after.status(), 'revoked impersonation token → 401').toBe(401);
  });
});

// =============================================================================
// D — expiry (short-TTL override)
// =============================================================================
test.describe.serial('D — time-boxing', () => {
  test('D1 — a short-TTL token expires on its own and is rejected afterwards', async ({ request }) => {
    test.setTimeout(60_000);
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { expiresInSeconds: 10 });
    expect(res.status()).toBe(200);
    const session = (await res.json()) as ImpersonateBody;
    expect(session.expiresInSeconds!).toBeLessThanOrEqual(10);

    const live = await request.get('/api/v1/auth/me', { headers: bearer(session.token) });
    expect(live.status(), 'token valid before expiry').toBe(200);

    await new Promise((r) => setTimeout(r, 12_000));

    const dead = await request.get('/api/v1/auth/me', { headers: bearer(session.token) });
    expect(dead.status(), 'expired impersonation token → 401').toBe(401);
  });
});

// =============================================================================
// E — safeguard matrix
// =============================================================================
test.describe.serial('E — safeguards', () => {
  test('E1 — doctor and tenant-admin callers are rejected (super-admin only)', async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor).toBeTruthy();
    const asDoctor = await impersonate(request, SEEDED_USERS.doctor2.id, {}, doctor!.token);
    expect(asDoctor.status(), 'doctor caller → 403').toBe(403);

    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin).toBeTruthy();
    const asAdmin = await impersonate(request, SEEDED_USERS.doctor.id, {}, admin!.token);
    expect(asAdmin.status(), 'tenant-admin caller → 403 (manage:all posture)').toBe(403);
  });

  test('E2 — self-impersonation is rejected', async ({ request }) => {
    const res = await impersonate(request, saUserId);
    expect(res.status(), 'self target → 400').toBe(400);
    expect(((await res.json()) as { message?: string }).message).toMatch(/yourself/i);
  });

  test('E3 — elevated-tier target (seeded GLOBAL_ADMIN) is rejected', async ({ request }) => {
    const res = await impersonate(request, GLOBAL_ADMIN_USER_ID);
    expect(res.status(), 'GLOBAL_ADMIN target → 400').toBe(400);
    // The guard message says "global administrator".
    expect(((await res.json()) as { message?: string }).message).toMatch(/global administrator/i);
  });

  test('E4 — disabled target is rejected; unknown target is 404', async ({ request }) => {
    // Throwaway target — created ENABLED, then disabled via the API (no seed mutation).
    const create = await request.post('/api/v1/admin/users', {
      headers: bearer(saToken),
      data: { username: `t401disabled_${UNIQUE}`, password: 'Password123!', email: `t401.disabled.${UNIQUE}@example.com` },
    });
    expect(create.status(), 'create throwaway target').toBeLessThan(300);
    const target = (await create.json()) as { id: string };

    try {
      const disable = await request.patch(`/api/v1/admin/users/${target.id}`, {
        headers: bearer(saToken),
        data: { resourceStatus: 'DISABLED' },
      });
      expect(disable.status(), 'disable throwaway target').toBe(200);

      const res = await impersonate(request, target.id);
      expect(res.status(), 'disabled target → 400').toBe(400);
      expect(((await res.json()) as { message?: string }).message).toMatch(/not enabled/i);
    } finally {
      // Soft-delete via the API (repository.softDelete — no hard delete).
      await request.delete(`/api/v1/admin/users/${target.id}`, { headers: bearer(saToken) }).catch(() => undefined);
    }

    const missing = await impersonate(request, '00000000-dead-beef-0000-000000000000');
    expect(missing.status(), 'unknown target → 404').toBe(404);
  });

  test('E5 — nested impersonation is rejected on BOTH endpoints', async ({ request }) => {
    const res = await impersonate(request, SEEDED_USERS.doctor.id, { reason: `t401 E5 ${UNIQUE}` });
    expect(res.status()).toBe(200);
    const session = (await res.json()) as ImpersonateBody;

    // New endpoint: the impersonated session fails the super-admin gate
    // (and the nested guard behind it) — never 2xx.
    const nestedNew = await impersonate(request, SEEDED_USERS.doctor2.id, {}, session.token);
    expect(nestedNew.status(), 'nested start via /admin/users/:id/impersonate → 403').toBe(403);

    // Legacy endpoint: reachable pre-role-check, so the dedicated nested
    // guard must fire with its explicit message.
    const nestedLegacy = await request.post('/api/v1/auth/impersonate', {
      headers: bearer(session.token),
      data: { targetUserId: SEEDED_USERS.doctor2.id },
    });
    expect(nestedLegacy.status(), 'nested start via legacy /auth/impersonate → 403').toBe(403);
    expect(((await nestedLegacy.json()) as { message?: string }).message).toMatch(/impersonated session cannot start/i);

    // Hygiene: end the session.
    await request.post('/api/v1/auth/revoke-impersonation', { headers: bearer(session.token) }).catch(() => undefined);
  });
});
