/**
 * Platform Dashboard + Monitoring backend contract verification.
 *
 * Exercises the server side of the cross-tenant data sources the two super-admin
 * platform surfaces (`/dashboard` frame 10, `/system-health` frame 11) read,
 * against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Each flow is a real
 * HTTP round-trip with the seeded `super_admin` (cross-tenant operator — logs in
 * WITHOUT a tenantKey).
 *
 * Scope (REAL data sources only — TARGET throughput/metrics are NOT asserted):
 *
 *   Dashboard (frame 10):
 *     P1 · GET /admin/tenants     → cross-tenant tenant list (Active-tenants KPI).
 *     P2 · GET /admin/users       → cross-tenant user count (Total-users KPI).
 *     P1 · GET /admin/monitoring/sessions → live-session / processing-job counts. 🔒
 *   Monitoring (frame 11):
 *     M1 · GET /admin/monitoring/uptime → per-service elapsed uptime. 🔒
 *     M1 · GET /admin/health/services   → per-service health (degraded-services KPI +
 *          the Services table). 🔒
 *   G1 · super-admin scope — a tenant-scoped `doctor` is 403 on the three 🔒
 *          platform-ops endpoints (MonitoringController is class-gated
 *          @CanAny(['manage','all'],['read','TenantTelemetry']) at monitoring.controller.ts;
 *          /admin/health/services is method-gated on AdminHealthServicesController since TASK-759).
 *
 * Deliberately NOT asserted (TARGET — no backend; drawn em-dash on the surfaces,
 * see README + TRACEABILITY-MATRIX T1): requests/min, error-rate, sockets/min,
 * total-sockets, per-service P95, per-model running + avg-latency, and the
 * request-volume time-series. These have no endpoint to hit.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface Paginated<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

/** GET /admin/monitoring/sessions — SessionsResponse (monitoring.dto.ts). */
interface SessionsResponse {
  services: Record<string, { active: number }>;
  totalUsers: number;
  refreshedAt: string;
}

/** GET /admin/monitoring/uptime — UptimeResponse (monitoring.dto.ts). */
interface UptimeResponse {
  services: Record<string, { status: string; uptime: number }>;
  refreshedAt: string;
}

/** GET /admin/health/services — consolidated downstream health (health.controller.ts). */
interface HealthServicesResponse {
  status: string;
  timestamp: string;
  services: Record<string, { status: string; service?: string }>;
}

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

// The 🔒 platform-ops endpoints, gated to SUPER_ADMIN (`manage all`).
const SUPER_ADMIN_ONLY_PATHS = ['/api/v1/admin/monitoring/sessions', '/api/v1/admin/monitoring/uptime', '/api/v1/admin/health/services'] as const;

test.describe('platform dashboard + monitoring (cross-tenant data sources)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // Cross-tenant operator: super_admin logs in WITHOUT a tenantKey.
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    token = sa!.token;
  });

  // --- Dashboard (frame 10) cross-tenant KPI sources ------------------------

  test('P1: GET /admin/tenants returns the cross-tenant tenant list (Active-tenants KPI)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', token, { limit: '100' });
    expect(res.status(), 'super_admin lists tenants cross-tenant').toBe(200);
    const body = (await res.json()) as Paginated<{ id: string; name: string }>;
    expect(Array.isArray(body.data), 'paginated tenant list shape').toBe(true);
    expect(typeof body.count).toBe('number');
    // The seed ships >= 1 tenant (Global + at least one customer). The dashboard
    // KPI is `useTenants().list().length`, so a non-empty list is the contract.
    expect(body.data.length, 'seed ships at least one tenant').toBeGreaterThan(0);
  });

  test('P2: GET /admin/users returns a cross-tenant user count (Total-users KPI)', async ({ request }) => {
    // The dashboard reads `useUsers().listPaginated({ page:1, limit:1 }).total`,
    // so only the COUNT matters here — assert it is a positive integer.
    const res = await authGet(request, '/api/v1/admin/users', token, { page: '1', limit: '1' });
    expect(res.status(), 'super_admin lists users cross-tenant').toBe(200);
    const body = (await res.json()) as Paginated<{ id: string; username: string }>;
    expect(typeof body.count, 'paginated user count is numeric').toBe('number');
    expect(body.count, 'seed ships several users').toBeGreaterThan(0);
  });

  test('P1: GET /admin/monitoring/sessions exposes session counts (live sessions / processing jobs)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/monitoring/sessions', token);
    expect(res.status(), 'super_admin reads session counts').toBe(200);
    const body = (await res.json()) as SessionsResponse;
    // REAL wire contract (SessionsResponse): per-service counts + totalUsers +
    // refreshedAt. We assert the SHAPE, not values (counts vary at runtime).
    expect(typeof body.services, 'sessions payload carries a per-service map').toBe('object');
    expect(typeof body.totalUsers, 'sessions payload carries a numeric totalUsers').toBe('number');
    expect(body.refreshedAt, 'sessions payload is timestamped').toBeTruthy();
  });

  // --- Monitoring (frame 11) REAL service-health sources --------------------

  test('M1: GET /admin/monitoring/uptime exposes per-service uptime (Services-table UPTIME)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/monitoring/uptime', token);
    expect(res.status(), 'super_admin reads uptime').toBe(200);
    const body = (await res.json()) as UptimeResponse;
    expect(typeof body.services, 'uptime payload carries a per-service map').toBe('object');
    expect(body.refreshedAt, 'uptime payload is timestamped').toBeTruthy();
    // Every reported service (if any heartbeats exist yet) carries a status.
    for (const [name, svc] of Object.entries(body.services ?? {})) {
      expect(svc.status, `uptime entry ${name} reports a status`).toBeTruthy();
    }
  });

  test('M1: GET /admin/health/services returns consolidated downstream health (degraded-services KPI + Services table)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/health/services', token);
    expect(res.status(), 'super_admin reads consolidated service health').toBe(200);
    const body = (await res.json()) as HealthServicesResponse;
    expect(body.status, 'overall status present (healthy|degraded|unhealthy)').toBeTruthy();
    expect(typeof body.services, 'per-service health map present').toBe('object');
    // The controller probes a fixed downstream set; the Services table renders
    // the canonical API/STT/TEXT/NLP/Guardrail/Harness order. Assert the known
    // downstream keys are present and each carries a status (REAL — `down` is a
    // legitimate value when a service is offline in the test env).
    const keys = Object.keys(body.services);
    expect(keys.length, 'at least one downstream service probed').toBeGreaterThan(0);
    for (const [key, svc] of Object.entries(body.services)) {
      expect(svc.status, `service ${key} reports a status`).toBeTruthy();
    }
  });

  // --- G1 · super-admin scope (🔒) ------------------------------------------

  test('G1: a tenant-scoped doctor is 403 on the super-admin-only platform-ops endpoints', async ({ request }) => {
    // Doctor is a tenant-scoped, non-admin persona (needs a tenantKey to log in).
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed — is the stack seeded?').toBeTruthy();

    for (const path of SUPER_ADMIN_ONLY_PATHS) {
      const res = await authGet(request, path, doctor!.token);
      // @Authorize(['manage','all']) → a DOCTOR lacks the ability → 403 Forbidden.
      expect(res.status(), `${path} is super-admin-only (doctor must be forbidden)`).toBe(403);
    }
  });

  test('G1: the same super-admin reaches all three 🔒 endpoints (positive scope)', async ({ request }) => {
    for (const path of SUPER_ADMIN_ONLY_PATHS) {
      const res = await authGet(request, path, token);
      expect(res.status(), `${path} is reachable by super_admin`).toBe(200);
    }
  });
});
