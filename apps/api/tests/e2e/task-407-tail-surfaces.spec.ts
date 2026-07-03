/**
 * TASK-407 — tenant-admin tail surfaces (Stores detail · Audio processing ·
 * Agent Jobs · Harness).
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack
 * via `SKIP_DB_PRECHECK=true API_URL=http://localhost:8868/api/v1`). Personas
 * via `tests/helpers` (seeded super_admin / tenant_admin / doctor).
 *
 * Coverage:
 *   CASL   · every surface read → 401 unauthenticated, 403 doctor,
 *            200 tenant_admin (own tenant), 200 super_admin;
 *            cross-tenant id probes → 404 (DEF-C3 generic shape).
 *   Stores · bucket list exposes `quotaBytes` (TASK-386 field, may be null);
 *            read-only object listing per bucket (TASK-376 MinIO listing).
 *   Audio  · tenant-wide job list (paginated envelope) + status→count stats +
 *            by-status filter.
 *   Agents · NEW `GET /admin/prompt-templates/usage-records` paginated
 *            envelope + template filter; templates expose `lastTestScore` /
 *            `lastTestAt` (nullable).
 *   Harness· policy/audit/eval-runs/gate-queue are DB-backed 200s;
 *            `workflows` tolerates 200 (harness up) OR 503 (down — honest
 *            degradation, per the ticket's constraint).
 *
 * Non-destructive: GET-only.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** uuidv7-shaped id that exists in no environment (DEF-C3 probe). */
const SYNTHETIC_ID = '018f0000-0000-7407-8000-000000000407';

let superAdminToken: string; // logged into ARCAAI (the "other" tenant)
let tenantAdminToken: string; // logged into __GLOBAL__ (own tenant)
let doctorToken: string;

test.beforeAll(async ({ request }) => {
    const [sa, ta, doc] = await Promise.all([
        loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI'),
        loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
        loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
    ]);
    expect(sa, 'super_admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    expect(ta, 'tenant_admin login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    expect(doc, 'doctor login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    superAdminToken = sa!.token;
    tenantAdminToken = ta!.token;
    doctorToken = doc!.token;
});

// =============================================================================
// CASL matrix — shared read plane for the four surfaces
// =============================================================================
test.describe('TASK-407 CASL — tail-surface reads', () => {
    const READ_ENDPOINTS = [
        '/api/v1/admin/tenants/storage/buckets',
        '/api/v1/admin/audio/transcription-jobs',
        '/api/v1/admin/audio/transcription-jobs/stats',
        '/api/v1/admin/prompt-templates/usage-records',
        '/api/v1/admin/harness/policy',
        '/api/v1/admin/harness/audit',
        '/api/v1/admin/harness/eval-runs',
        '/api/v1/admin/harness/gate-queue',
    ];

    for (const url of READ_ENDPOINTS) {
        test(`GET ${url} → 401 unauth, 403 doctor, 200 tenant_admin, 200 super_admin`, async ({ request }) => {
            const unauth = await request.get(url);
            expect(unauth.status(), `${url} unauthenticated`).toBe(401);

            const doc = await request.get(url, { headers: bearer(doctorToken) });
            expect(doc.status(), `${url} doctor`).toBe(403);

            const ta = await request.get(url, { headers: bearer(tenantAdminToken) });
            expect(ta.status(), `${url} tenant_admin (own tenant)`).toBe(200);

            const sa = await request.get(url, { headers: bearer(superAdminToken) });
            expect(sa.status(), `${url} super_admin (ARCAAI scope)`).toBe(200);
        });
    }
});

// =============================================================================
// Stores detail — buckets expose quota; read-only object browsing; isolation
// =============================================================================
test.describe('TASK-407 Stores — bucket detail + objects', () => {
    interface BucketRow {
        id: string;
        tenantId?: string;
        slug?: string;
        name?: string;
        quotaBytes?: number | null;
    }

    test('bucket rows expose quotaBytes (TASK-386) and objects are listable read-only', async ({ request }) => {
        const list = await request.get('/api/v1/admin/tenants/storage/buckets', { headers: bearer(tenantAdminToken) });
        expect(list.status()).toBe(200);
        const rows = (await list.json()) as BucketRow[];
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length, '__GLOBAL__ seed ships system buckets').toBeGreaterThan(0);

        for (const row of rows) {
            expect(Object.prototype.hasOwnProperty.call(row, 'quotaBytes'), `bucket ${row.id} carries quotaBytes`).toBe(true);
            if (row.quotaBytes != null) expect(typeof row.quotaBytes).toBe('number');
        }

        const bucket = rows[0];
        const objects = await request.get(`/api/v1/admin/tenants/storage/buckets/${bucket.id}/objects`, {
            headers: bearer(tenantAdminToken),
        });
        expect(objects.status(), 'object listing (MinIO-backed)').toBe(200);
        const body = (await objects.json()) as unknown;
        const items = Array.isArray(body) ? body : ((body as { objects?: unknown[] }).objects ?? (body as { data?: unknown[] }).data);
        expect(Array.isArray(items), 'objects payload resolves to an array').toBe(true);
        for (const o of (items as Array<{ key?: string; size?: number }>).slice(0, 10)) {
            expect(typeof o.key).toBe('string');
            expect(typeof o.size).toBe('number');
        }
    });

    test('cross-tenant bucket object probe → 404; synthetic id → 404 (same shape)', async ({ request }) => {
        // Discover an ARCAAI bucket via the super-admin scope.
        const saList = await request.get('/api/v1/admin/tenants/storage/buckets', { headers: bearer(superAdminToken) });
        expect(saList.status()).toBe(200);
        const saRows = (await saList.json()) as BucketRow[];
        expect(saRows.length, 'ARCAAI seed ships system buckets').toBeGreaterThan(0);
        const foreignBucketId = saRows[0].id;

        const cross = await request.get(`/api/v1/admin/tenants/storage/buckets/${foreignBucketId}/objects`, {
            headers: bearer(tenantAdminToken),
        });
        expect(cross.status(), 'tenant_admin probing ARCAAI bucket objects').toBe(404);
        expect(String(((await cross.json()) as { message?: string }).message ?? '')).not.toMatch(/tenant/i);

        const synthetic = await request.get(`/api/v1/admin/tenants/storage/buckets/${SYNTHETIC_ID}/objects`, {
            headers: bearer(tenantAdminToken),
        });
        expect(synthetic.status(), 'synthetic bucket id').toBe(404);
    });
});

// =============================================================================
// Audio processing — tenant-wide job supervision
// =============================================================================
test.describe('TASK-407 Audio — transcription jobs', () => {
    test('job list returns the paginated envelope and honors limit', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/audio/transcription-jobs?page=1&limit=5', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const body = (await resp.json()) as { data: Array<{ id: string; status: string; tenantId?: string }>; total: number; page: number; limit: number };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeLessThanOrEqual(5);
        expect(typeof body.total).toBe('number');
        expect(body.page).toBe(1);
    });

    test('stats returns the status→count map used by the FE tiles', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/audio/transcription-jobs/stats', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const stats = (await resp.json()) as Record<string, number>;
        for (const key of ['queued', 'processing', 'completed', 'failed', 'cancelled', 'dead']) {
            expect(typeof stats[key], `stats.${key}`).toBe('number');
        }
    });

    test('by-status filter returns only matching jobs (uppercase enum param)', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/audio/transcription-jobs/status/COMPLETED', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const jobs = (await resp.json()) as Array<{ status: string }>;
        expect(Array.isArray(jobs)).toBe(true);
        for (const j of jobs.slice(0, 20)) expect(String(j.status).toUpperCase()).toBe('COMPLETED');
    });
});

// =============================================================================
// Agent Jobs — usage-record history (NEW endpoint) + last-test fields
// =============================================================================
test.describe('TASK-407 Agent Jobs — prompt usage records', () => {
    interface UsageRecord {
        id: string;
        promptTemplateId: string | null;
        promptVersionNumber: number | null;
        consultationId: string | null;
        doctorId: string | null;
        departmentId: string | null;
        createdAt: string;
    }

    test('usage-records returns the count/limit/page/data envelope and honors limit', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/prompt-templates/usage-records?page=1&limit=5', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const body = (await resp.json()) as { data: UsageRecord[]; count: number; page: number; limit: number };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeLessThanOrEqual(5);
        expect(typeof body.count).toBe('number');
        expect(body.page).toBe(1);
        expect(body.limit).toBe(5);
        for (const r of body.data) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.createdAt).toBe('string');
            expect(Object.prototype.hasOwnProperty.call(r, 'promptTemplateId')).toBe(true);
        }
    });

    test('promptTemplateId filter returns only records for that template', async ({ request }) => {
        const all = await request.get('/api/v1/admin/prompt-templates/usage-records?limit=50', { headers: bearer(tenantAdminToken) });
        expect(all.status()).toBe(200);
        const { data } = (await all.json()) as { data: UsageRecord[] };
        const withTemplate = data.find((r) => r.promptTemplateId != null);
        test.skip(!withTemplate, 'no seeded usage record carries a promptTemplateId — filter untestable in this environment');

        const filtered = await request.get(
            `/api/v1/admin/prompt-templates/usage-records?limit=50&promptTemplateId=${withTemplate!.promptTemplateId}`,
            { headers: bearer(tenantAdminToken) },
        );
        expect(filtered.status()).toBe(200);
        const { data: subset, count } = (await filtered.json()) as { data: UsageRecord[]; count: number };
        expect(count).toBeGreaterThan(0);
        for (const r of subset) expect(r.promptTemplateId).toBe(withTemplate!.promptTemplateId);
    });

    test('templates expose lastTestScore / lastTestAt (nullable) for the agents summary', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/prompt-templates', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const raw = (await resp.json()) as unknown;
        const rows = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] }).data ?? [])) as Array<Record<string, unknown>>;
        for (const t of rows) {
            if (t.lastTestScore != null) expect(typeof t.lastTestScore).toBe('number');
            if (t.lastTestAt != null) expect(typeof t.lastTestAt).toBe('string');
        }
    });
});

// =============================================================================
// Harness — DB-backed observability + honest Temporal degradation
// =============================================================================
test.describe('TASK-407 Harness — observability reads', () => {
    test('policy resolves with a source chip and OCC version', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/harness/policy', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const policy = (await resp.json()) as { tenantId: string; source: string; version: number };
        expect(typeof policy.tenantId).toBe('string');
        expect(['tenant', 'system-default', 'code-default']).toContain(policy.source);
        expect(typeof policy.version).toBe('number');
    });

    test('audit returns items + WORM chain verification verdict', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/harness/audit?limit=20', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const body = (await resp.json()) as {
            items: Array<{ id: string; action: string; hash: string }>;
            total: number;
            verification: { valid: boolean; brokenAtIndex: number | null };
        };
        expect(Array.isArray(body.items)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(typeof body.verification?.valid).toBe('boolean');
    });

    test('eval-runs list + cross-tenant/synthetic detail probes → 404', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/harness/eval-runs?limit=10', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const body = (await resp.json()) as { items: Array<{ id: string; tenantId: string }>; total: number };
        expect(Array.isArray(body.items)).toBe(true);

        const synthetic = await request.get(`/api/v1/admin/harness/eval-runs/${SYNTHETIC_ID}`, { headers: bearer(tenantAdminToken) });
        expect(synthetic.status(), 'synthetic eval-run id (DEF-C3 shape)').toBe(404);

        // If ARCAAI has any eval run, its id must 404 for the __GLOBAL__ admin.
        const saRuns = await request.get('/api/v1/admin/harness/eval-runs?limit=1', { headers: bearer(superAdminToken) });
        expect(saRuns.status()).toBe(200);
        const saBody = (await saRuns.json()) as { items: Array<{ id: string }> };
        if (saBody.items.length > 0) {
            const cross = await request.get(`/api/v1/admin/harness/eval-runs/${saBody.items[0].id}`, { headers: bearer(tenantAdminToken) });
            expect(cross.status(), 'cross-tenant eval-run probe').toBe(404);
        }
    });

    test('gate-queue reports totals + SLA config from the effective policy', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/harness/gate-queue', { headers: bearer(tenantAdminToken) });
        expect(resp.status()).toBe(200);
        const body = (await resp.json()) as {
            items: unknown[];
            total: number;
            slaBreachedCount: number;
            escalatedCount: number;
            gateSlaSeconds: number;
            policySource: string;
        };
        expect(Array.isArray(body.items)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(typeof body.slaBreachedCount).toBe('number');
        expect(typeof body.escalatedCount).toBe('number');
        expect(typeof body.gateSlaSeconds).toBe('number');
        expect(['tenant', 'system-default', 'code-default']).toContain(body.policySource);
    });

    test('workflows → 200 (harness up) or 503 (down — honest degradation)', async ({ request }) => {
        const resp = await request.get('/api/v1/admin/harness/workflows?limit=5', { headers: bearer(tenantAdminToken) });
        expect([200, 503], `workflows returned ${resp.status()}`).toContain(resp.status());
        if (resp.status() === 200) {
            const body = (await resp.json()) as { items: unknown[] };
            expect(Array.isArray(body.items)).toBe(true);
        } else {
            // 503 must be the framed ServiceUnavailable error, not a crash.
            const body = (await resp.json()) as { statusCode?: number };
            expect(body.statusCode).toBe(503);
        }
    });
});
