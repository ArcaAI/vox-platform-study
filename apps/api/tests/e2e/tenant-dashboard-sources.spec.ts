/**
 * Tenant Dashboard (frame 18d) backend contract verification.
 *
 * The `18d` Tenant Dashboard (admin Overview tab) has NO aggregate KPI endpoint;
 * it fans out across the existing list/monitoring sources with
 * `Promise.allSettled` and derives its view-models client-side. This spec pins
 * the REAL server contract those five sources must satisfy, plus the tenant
 * isolation / RBAC posture the dashboard relies on. It deliberately does NOT
 * assert any TARGET flow (open sockets, consumption, per-model stream counts, or
 * server-side range aggregation) — those have no backend (see
 * docs/qa/traceability/tenant-dashboard.md §3).
 *
 * Sources & verified gating (apps/api, 2026-06-30):
 *   1. GET /admin/tenants/:id/usage  tenant.controller.ts:151  → getUsageStats
 *      — @CanAny(['manage','Tenant'],['update','Tenant']); per-row
 *        `assertTenantInScope` (:63): non-super-admin reading ANOTHER tenant → 403.
 *   2. GET /admin/audit-logs         audit-log.controller.ts:65 (fetchAll)
 *      — @CanRead('AuditLog'); tenant-scoped, super-admin cross-tenant.
 *   3. GET /monitoring/sessions      monitoring.controller.ts 🔒
 *      — controller @CanAny(['manage','all'],['read','TenantTelemetry']):
 *        SUPER_ADMIN via manage:all, TENANT_ADMIN via the
 *        read:TenantTelemetry grant; a plain DOCTOR (neither) → 403.
 *   4. GET /health/services          health.controller.ts 🔒
 *      — same @CanAny posture as /monitoring/sessions.
 *   5. GET /admin/consultations      admin-consultation.controller.ts:52 (list)
 *      — @CanManage('Consultation') → TENANT_ADMIN / SUPER_ADMIN; DOCTOR → 403.
 *
 * Run against a live, seeded stack (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Each flow is a real
 * HTTP round-trip with seeded personas (super_admin = cross-tenant operator,
 * tenant_admin = __GLOBAL__-scoped, doctor = non-admin).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface TenantRow {
  id: string;
  name: string;
  key?: string;
}
interface PaginatedTenants {
  data: TenantRow[];
  count: number;
  page: number;
  limit: number;
}
interface UsageStats {
  totalUsers: number;
  totalDepartments: number;
  totalPromptTemplates?: number;
  totalPipelines?: number;
}
interface SessionsResponse {
  services: Record<string, { active: number }>;
  totalUsers: number;
  refreshedAt: string;
}
interface ServiceHealthResponse {
  status: string;
  timestamp: string;
  services: Record<string, { status: string; service?: string }>;
}
interface PaginatedConsultations {
  data: Array<{ id: string }>;
  count: number;
  page: number;
  limit: number;
}

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

test.describe('Tenant Dashboard (18d) backend sources', () => {
  let superToken: string;
  let tenantAdminToken: string;
  let doctorToken: string;
  /** A tenant the tenant_admin belongs to (__GLOBAL__). */
  let ownTenantId: string;
  /** A tenant the tenant_admin does NOT belong to (for the isolation case); may be undefined on a single-tenant seed. */
  let otherTenantId: string | undefined;

  test.beforeAll(async ({ request }) => {
    // super_admin = cross-tenant operator (no tenantKey).
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    superToken = sa!.token;

    // tenant_admin is scoped to the __GLOBAL__ tenant; doctor is a non-admin in the same tenant.
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
    tenantAdminToken = ta!.token;

    const doc = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
    doctorToken = doc!.token;

    // Resolve tenant ids from the cross-tenant listing (no seeded id constant).
    const list = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '100' });
    expect(list.status(), 'super_admin can list tenants').toBe(200);
    const tenants = ((await list.json()) as PaginatedTenants).data;
    const own = tenants.find((t) => t.key === DEFAULT_TENANT_KEY) ?? tenants[0];
    expect(own, 'at least one tenant is seeded').toBeTruthy();
    ownTenantId = own.id;
    otherTenantId = tenants.find((t) => t.id !== ownTenantId)?.id;
  });

  // --- TD1 — Tenant usage KPIs (Active users / Departments) -------------------

  test('TD1: super_admin reads tenant usage with numeric users + departments', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/tenants/${ownTenantId}/usage`, superToken);
    expect(res.status(), 'GET /admin/tenants/:id/usage (super_admin)').toBe(200);
    const usage = (await res.json()) as UsageStats;
    expect(typeof usage.totalUsers, 'totalUsers is numeric').toBe('number');
    expect(typeof usage.totalDepartments, 'totalDepartments is numeric').toBe('number');
    expect(usage.totalUsers).toBeGreaterThanOrEqual(0);
    expect(usage.totalDepartments).toBeGreaterThanOrEqual(0);
  });

  test('TD1: tenant_admin reads its OWN tenant usage', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/tenants/${ownTenantId}/usage`, tenantAdminToken);
    expect(res.status(), 'tenant_admin reads own-tenant usage (assertTenantInScope passes)').toBe(200);
    const usage = (await res.json()) as UsageStats;
    expect(typeof usage.totalUsers).toBe('number');
  });

  // --- TD4 — Recent-activity audit feed --------------------------------------

  test('TD4: super_admin reads the (cross-tenant) audit feed as a paginated list', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/audit-logs', superToken, { limit: '8' });
    expect(res.status(), 'GET /admin/audit-logs (super_admin)').toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data), 'audit-logs returns a data array').toBe(true);
  });

  test('TD4: tenant_admin reads its own-tenant audit feed', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/audit-logs', tenantAdminToken, { limit: '8' });
    expect(res.status(), 'tenant_admin has tenant context → 200 (X5 guard satisfied)').toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  // --- TD1/TD2 — Monitoring sessions (🔒 manage:all OR read:TenantTelemetry) --

  test('TD2: super_admin reads /monitoring/sessions shape (services + totalUsers)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/monitoring/sessions', superToken);
    expect(res.status(), 'GET /monitoring/sessions (super_admin)').toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(typeof body.services, 'sessions has a per-service map').toBe('object');
    expect(typeof body.totalUsers, 'totalUsers is numeric').toBe('number');
  });

  // TENANT_ADMIN intentionally holds the seeded `read:TenantTelemetry` rule
  // so the tenant dashboard can read platform-infra session counts.
  test('TD2: tenant_admin (own tenant, read:TenantTelemetry) reads /monitoring/sessions', async ({ request }) => {
    const res = await authGet(request, '/api/v1/monitoring/sessions', tenantAdminToken);
    expect(res.status(), 'tenant_admin holds read:TenantTelemetry (TASK-386 #21) → 200').toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(typeof body.services, 'sessions has a per-service map').toBe('object');
    expect(typeof body.totalUsers, 'totalUsers is numeric').toBe('number');
  });

  test('TD2: doctor is FORBIDDEN from /monitoring/sessions', async ({ request }) => {
    const res = await authGet(request, '/api/v1/monitoring/sessions', doctorToken);
    expect(res.status(), 'a plain doctor holds neither manage:all nor read:TenantTelemetry → 403').toBe(403);
  });

  // --- TD1/TD5 — Service health (🔒 manage:all OR read:TenantTelemetry) ------

  test('TD5: super_admin reads /health/services shape (status + per-service map)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/health/services', superToken);
    expect(res.status(), 'GET /health/services (super_admin)').toBe(200);
    const body = (await res.json()) as ServiceHealthResponse;
    expect(typeof body.status, 'overall status string present').toBe('string');
    expect(typeof body.services, 'per-service health map present').toBe('object');
    // The audio-pipeline strip reads these keys (smr/stt/nlp/guardrail/harness);
    // assert the SHAPE, not the health (services may be down in a test env).
    expect(Object.keys(body.services).length, 'at least one downstream service reported').toBeGreaterThan(0);
  });

  // Same `read:TenantTelemetry` widening as TD2: the
  // tenant dashboard's audio-pipeline strip reads downstream health, so a
  // TENANT_ADMIN with read:TenantTelemetry gets 200.
  test('TD5: tenant_admin (own tenant, read:TenantTelemetry) reads /health/services', async ({ request }) => {
    const res = await authGet(request, '/api/v1/health/services', tenantAdminToken);
    expect(res.status(), 'tenant_admin holds read:TenantTelemetry (TASK-386 #21) → 200').toBe(200);
    const body = (await res.json()) as ServiceHealthResponse;
    expect(typeof body.status, 'overall status string present').toBe('string');
    expect(typeof body.services, 'per-service health map present').toBe('object');
  });

  test('TD5: doctor is FORBIDDEN from /health/services (neither grant)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/health/services', doctorToken);
    expect(res.status(), 'a plain doctor holds neither manage:all nor read:TenantTelemetry → 403').toBe(403);
  });

  test('TD5: the PUBLIC /health liveness probe stays open (sanity vs the gated /services)', async ({ request }) => {
    const res = await request.get('/api/v1/health/live');
    expect(res.status(), '/health/live is @Public()').toBe(200);
  });

  // --- TD2/TD3/TD4 — Admin consultations list --------------------------------

  test('TD3: super_admin reads the admin consultations list (paginated)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/consultations', superToken, { page: '1', limit: '50' });
    expect(res.status(), 'GET /admin/consultations (super_admin)').toBe(200);
    const body = (await res.json()) as PaginatedConsultations;
    expect(Array.isArray(body.data), 'consultations returns a data array').toBe(true);
  });

  test('TD3: tenant_admin reads its own-tenant consultations (tenant-scoped)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/consultations', tenantAdminToken, { page: '1', limit: '50' });
    expect(res.status(), 'tenant_admin holds manage:Consultation (tenant-scoped) → 200').toBe(200);
    const body = (await res.json()) as PaginatedConsultations;
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('TD3: doctor is FORBIDDEN from the admin consultations list (no manage:Consultation)', async ({ request }) => {
    // The end-user controller scopes a doctor to OWN consultations; the admin
    // (tenant-wide) surface requires manage:Consultation, which a DOCTOR lacks.
    const res = await authGet(request, '/api/v1/admin/consultations', doctorToken, { page: '1', limit: '50' });
    expect(res.status()).toBe(403);
  });

  // --- TD7 — Scope & RBAC: tenant isolation on per-tenant usage ---------------

  test('TD7: tenant_admin reading ANOTHER tenant\u2019s usage is rejected (assertTenantInScope)', async ({ request }) => {
    test.skip(!otherTenantId, 'single-tenant seed — no cross-tenant id available for the isolation case');
    const res = await authGet(request, `/api/v1/admin/tenants/${otherTenantId}/usage`, tenantAdminToken);
    // assertTenantInScope throws ForbiddenException for a non-super-admin
    // addressing a tenant that is not its own.
    expect(res.status(), 'cross-tenant usage read is blocked for a tenant-admin').toBe(403);
  });

  test('TD7: unauthenticated requests to the dashboard sources are 401', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs');
    expect(res.status(), 'no bearer → 401').toBe(401);
  });
});
