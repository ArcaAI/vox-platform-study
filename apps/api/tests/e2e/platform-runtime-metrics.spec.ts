/**
 * Platform Runtime Metrics backend contract verification (PM1–PM7).
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Mirrors the harness of
 * platform-dashboard-monitoring.spec.ts (seeded `super_admin` = cross-tenant
 * operator, logs in WITHOUT a tenantKey; `tenant_admin`/`doctor` log in with the
 * default tenant key).
 *
 * Coverage (plan §4.4):
 *   PM1 · GET /admin/platform/metrics      → 200 + E1 shape.
 *   PM2 · GET /admin/platform/sockets      → 200; `open` ≥ 0 integer (#17).
 *   PM3 · GET /admin/platform/consumption  → 200; numeric Postgres roll-ups (#18).
 *   PM4 · GET /admin/consultations/aggregate → 200; zero-filled buckets; Σ = totals (#20).
 *   PM5 · GET /admin/tenants/:id/usage     → 200; extended storage/clinical fields (#4/#5).
 *   PM6 · GET /monitoring/sessions + /health/services — tenant_admin 200, doctor 403 (#21/E6).
 *   PM7 · GET /admin/consultations (super_admin, NO tenant scope) → 200 cross-tenant (TD3/DEF-1).
 *
 * ENV-DEPENDENT: the Prometheus-derived fields in PM1 (requests/error/p95/per-model
 * series) and the churn rate in PM2 degrade to 0/[]/null when Prometheus is not in
 * the TEST stack — so PM1/PM2 assert 200 + SHAPE/TYPES, not exact values. The
 * DB-aggregation endpoints (PM3 consumption, PM4 aggregate, PM5 usage) and the PM7
 * TD3 cross-tenant fix are fully live against Postgres and asserted for real.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface Paginated<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

interface PlatformMetricsResponse {
  requestsPerMinute: number;
  errorRatePct: number;
  p95LatencyMs: number;
  openSockets: number;
  socketsPerMinute: number;
  services: { key: string; p95LatencyMs: number | null; requestsPerMinute: number | null; errorRatePct: number | null }[];
  models: { running: number; perModel: { id: string; service: string; running: number | null; avgLatencyMs: number | null }[] };
  requestVolumeSeries: { t: string; requests: number; sockets: number }[];
  refreshedAt: string;
}

interface OpenSocketsResponse {
  open: number;
  perMinute: number;
  total: number;
  refreshedAt: string;
}

interface ConsumptionRollupResponse {
  transcriptionMinutes: number;
  summaries24h: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  consultations: { total: number; today: number };
  refreshedAt: string;
}

interface ConsultationAggregateResponse {
  buckets: { key: string; label: string; start: string; end: string; newVisits: number; revisits: number; total: number }[];
  totals: { total: number; newVisits: number; revisits: number };
  granularity: 'day' | 'month';
  refreshedAt: string;
}

interface TenantUsageResponse {
  totalUsers: number;
  totalDepartments: number;
  totalPromptTemplates: number;
  totalPipelines: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  transcriptionMinutes: number;
  summaries24h: number;
  totalConsultations: number;
}

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

/** `yyyy-MM-dd` for `today + offsetDays` in UTC (matches the server's UTC bucketing). */
function utcDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const isNonNegInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNonNegNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

test.describe('platform runtime metrics (PM1–PM7)', () => {
  let superToken: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    superToken = sa!.token;
  });

  // --- PM1 · E1 platform metrics --------------------------------------------

  test('PM1: GET /admin/platform/metrics → 200 with the E1 shape', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/platform/metrics', superToken);
    expect(res.status(), 'super_admin reads platform metrics').toBe(200);
    const body = (await res.json()) as PlatformMetricsResponse;

    // Top-level numeric KPIs (Prometheus-derived → may be 0 without Prometheus).
    for (const k of ['requestsPerMinute', 'errorRatePct', 'p95LatencyMs', 'openSockets', 'socketsPerMinute'] as const) {
      expect(typeof body[k], `metrics.${k} is numeric`).toBe('number');
    }
    // openSockets is a Redis aggregate (accurate without Prometheus) → ≥ 0 integer.
    expect(isNonNegInt(body.openSockets), 'openSockets is a non-negative integer (#17)').toBe(true);

    expect(Array.isArray(body.services), 'services[] present').toBe(true);
    expect(body.models && Array.isArray(body.models.perModel), 'models.perModel[] present (#19)').toBe(true);
    expect(Array.isArray(body.requestVolumeSeries), 'requestVolumeSeries[] present').toBe(true);
    expect(body.refreshedAt, 'payload is timestamped').toBeTruthy();
  });

  // --- PM2 · E2 open sockets -------------------------------------------------

  test('PM2: GET /admin/platform/sockets → 200; open is a non-negative integer (#17)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/platform/sockets', superToken);
    expect(res.status(), 'super_admin reads open-sockets tile').toBe(200);
    const body = (await res.json()) as OpenSocketsResponse;
    expect(isNonNegInt(body.open), 'open is a non-negative integer').toBe(true);
    expect(typeof body.perMinute, 'perMinute is numeric (0 without Prometheus)').toBe('number');
    expect(isNonNegInt(body.total), 'total is a non-negative integer').toBe(true);
    expect(body.refreshedAt, 'payload is timestamped').toBeTruthy();
  });

  // --- PM3 · E3 consumption roll-up (Postgres — live) ------------------------

  test('PM3: GET /admin/platform/consumption → 200 with numeric Postgres roll-ups (#18)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/platform/consumption', superToken);
    expect(res.status(), 'super_admin reads platform-wide consumption').toBe(200);
    const body = (await res.json()) as ConsumptionRollupResponse;
    expect(isNonNegNum(body.transcriptionMinutes), 'transcriptionMinutes ≥ 0').toBe(true);
    expect(isNonNegInt(body.summaries24h), 'summaries24h ≥ 0 integer').toBe(true);
    expect(isNonNegNum(body.storageUsedBytes), 'storageUsedBytes ≥ 0').toBe(true);
    expect(body.storageQuotaBytes === null || isNonNegNum(body.storageQuotaBytes), 'storageQuotaBytes is null or ≥ 0').toBe(true);
    expect(isNonNegInt(body.consultations.total), 'consultations.total ≥ 0 integer').toBe(true);
    expect(isNonNegInt(body.consultations.today), 'consultations.today ≥ 0 integer').toBe(true);
    expect(body.refreshedAt, 'payload is timestamped').toBeTruthy();
  });

  // --- PM4 · E4 consultation aggregate (Postgres — live) ---------------------

  test('PM4: GET /admin/consultations/aggregate (day) → zero-filled buckets; Σ buckets = totals (#20)', async ({ request }) => {
    const from = utcDay(-6);
    const to = utcDay(0);
    const res = await authGet(request, '/api/v1/admin/consultations/aggregate', superToken, { from, to, granularity: 'day' });
    expect(res.status(), 'super_admin aggregates cross-tenant').toBe(200);
    const body = (await res.json()) as ConsultationAggregateResponse;

    expect(body.granularity, 'granularity honoured').toBe('day');
    // Zero-filled: a 7-day inclusive window → exactly 7 day buckets.
    expect(body.buckets.length, '7-day inclusive window → 7 zero-filled buckets').toBe(7);
    for (const b of body.buckets) {
      expect(b.key, 'bucket has a key').toBeTruthy();
      expect(b.total, 'bucket.total = newVisits + revisits').toBe(b.newVisits + b.revisits);
      expect(isNonNegInt(b.newVisits) && isNonNegInt(b.revisits), 'bucket counts are ≥ 0 integers').toBe(true);
    }
    // The headline invariant (#20): the buckets never under-count the totals.
    const sumTotal = body.buckets.reduce((s, b) => s + b.total, 0);
    const sumNew = body.buckets.reduce((s, b) => s + b.newVisits, 0);
    const sumRev = body.buckets.reduce((s, b) => s + b.revisits, 0);
    expect(sumTotal, 'Σ bucket.total === totals.total').toBe(body.totals.total);
    expect(sumNew, 'Σ bucket.newVisits === totals.newVisits').toBe(body.totals.newVisits);
    expect(sumRev, 'Σ bucket.revisits === totals.revisits').toBe(body.totals.revisits);
  });

  test('PM4b: aggregate requires both from and to (400 otherwise)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/consultations/aggregate', superToken, { from: utcDay(-6) });
    expect(res.status(), 'missing `to` is a 400').toBe(400);
  });

  // --- PM5 · E5 tenant usage (Postgres — live) -------------------------------

  test('PM5: GET /admin/tenants/:id/usage → 200 with extended storage + clinical fields (#4/#5)', async ({ request }) => {
    const listRes = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '100' });
    expect(listRes.status(), 'super_admin lists tenants').toBe(200);
    const tenants = (await listRes.json()) as Paginated<{ id: string; name: string }>;
    expect(tenants.data.length, 'seed ships at least one tenant').toBeGreaterThan(0);
    const tenantId = tenants.data[0].id;

    const res = await authGet(request, `/api/v1/admin/tenants/${tenantId}/usage`, superToken);
    expect(res.status(), 'super_admin reads tenant usage').toBe(200);
    const body = (await res.json()) as TenantUsageResponse;
    // Pre-existing inventory counts stay present …
    for (const k of ['totalUsers', 'totalDepartments', 'totalPromptTemplates', 'totalPipelines'] as const) {
      expect(isNonNegInt(body[k]), `usage.${k} ≥ 0 integer`).toBe(true);
    }
    // … plus the storage (#5) and clinical (#16) extensions.
    expect(isNonNegNum(body.storageUsedBytes), 'storageUsedBytes ≥ 0 (#5)').toBe(true);
    expect(body.storageQuotaBytes === null || isNonNegNum(body.storageQuotaBytes), 'storageQuotaBytes null or ≥ 0 (#5)').toBe(true);
    expect(isNonNegNum(body.transcriptionMinutes), 'transcriptionMinutes ≥ 0 (#16)').toBe(true);
    expect(isNonNegInt(body.summaries24h), 'summaries24h ≥ 0 integer (#16)').toBe(true);
    expect(isNonNegInt(body.totalConsultations), 'totalConsultations ≥ 0 integer (#16)').toBe(true);
  });

  // --- PM6 · #21/E6 widened telemetry gates ----------------------------------

  test('PM6: tenant_admin can read /monitoring/sessions + /health/services; a doctor is 403', async ({ request }) => {
    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(tenantAdmin, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed — is the stack seeded?').toBeTruthy();

    // Service sessions/health are platform-infra status (no per-tenant rows), so
    // #21 widens the gate (read:TenantTelemetry) rather than filtering rows: a
    // TENANT_ADMIN may now read; a plain DOCTOR (neither grant) is still forbidden.
    for (const path of ['/api/v1/monitoring/sessions', '/api/v1/health/services'] as const) {
      const ta = await authGet(request, path, tenantAdmin!.token);
      expect(ta.status(), `${path} reachable by tenant_admin (read:TenantTelemetry)`).toBe(200);

      const doc = await authGet(request, path, doctor!.token);
      expect(doc.status(), `${path} forbidden for a plain doctor`).toBe(403);

      const sa = await authGet(request, path, superToken);
      expect(sa.status(), `${path} reachable by super_admin (manage:all)`).toBe(200);
    }
  });

  test('PM6b: platform metrics endpoints stay super-admin-only (tenant_admin + doctor 403)', async ({ request }) => {
    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    for (const token of [tenantAdmin!.token, doctor!.token]) {
      const res = await authGet(request, '/api/v1/admin/platform/metrics', token);
      expect(res.status(), '/admin/platform/* is gated to manage:all').toBe(403);
    }
  });

  // --- PM7 · TD3 / DEF-1 cross-tenant contract -------------------------------

  test('PM7: super_admin GET /admin/consultations with NO tenant scope → 200 cross-tenant (TD3/DEF-1)', async ({ request }) => {
    // Regression coverage: this previously returned 400 because the list
    // required a working tenant. The approved contract (Decision #4) makes a
    // super_admin with no scope aggregate cross-tenant — which unblocks the
    // Platform Dashboard's consultations sources (DEF-1).
    const res = await authGet(request, '/api/v1/admin/consultations', superToken, { page: '1', limit: '20' });
    expect(res.status(), 'super_admin lists consultations cross-tenant (was 400)').toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(Array.isArray(body.data), 'paginated consultation list shape').toBe(true);
    expect(typeof body.count, 'paginated count is numeric').toBe('number');
  });

  test('PM7b: tenant_admin GET /admin/consultations → 200 (pinned to their tenant); doctor → 403', async ({ request }) => {
    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);

    const ta = await authGet(request, '/api/v1/admin/consultations', tenantAdmin!.token, { page: '1', limit: '20' });
    expect(ta.status(), 'tenant_admin lists their own tenant consultations').toBe(200);

    // @CanManage('Consultation') is class-gated → a plain doctor is forbidden.
    const doc = await authGet(request, '/api/v1/admin/consultations', doctor!.token, { page: '1', limit: '20' });
    expect(doc.status(), 'doctor is not a Consultation manager').toBe(403);
  });
});
