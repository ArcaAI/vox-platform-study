/**
 * Super-admin ops surfaces (Rate Limits · Queues & Jobs · Prisma Studio).
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`). Harness mirrors
 * (seeded personas via `tests/helpers`).
 *
 * Coverage:
 *   CASL  · every ops endpoint → 401 unauthenticated, 403 for tenant_admin and
 *           doctor (all three surfaces are `manage all` = GLOBAL_ADMIN only).
 *   14    · GET /admin/rate-limit policy shape; kill-switch round-trip
 *           (ON → verify → OFF → verify — ALWAYS ends OFF); strict-tier limit
 *           round-trip (bump → verify db source → restore original).
 *   15    · GET /admin/queues lists every registered queue with counts;
 *           GET /admin/queues/health/redis is healthy;
 *           failed-job lifecycle: a synthetic poisoned IngestKnowledgeDocument
 *           job (missing tenantId → the processor's fail-closed guard throws
 *           BEFORE any DB/harness access) is enqueued straight into the test
 *           Redis, observed as `failed` via listing + detail, then
 *           POST .../retry re-runs it (attempts 1 → 2). Non-destructive: the
 *           fixture job ages out via removeOnFail like every platform job.
 *   16    · GET /admin/pstudio/status reports
 *           enabled:false under NODE_ENV=test, and the dev-only Studio shell
 *           (GET /admin/pstudio) is genuinely absent (404).
 *
 * No destructive queue ops are exercised (no clean/drain/remove/pause).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Queue } from 'bullmq';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const INGEST_QUEUE = 'IngestKnowledgeDocument';
const FIXTURE_JOB_NAME = 'task403-e2e-fixture';

interface TierPolicy {
  tier: string;
  limit: number;
  ttl: number;
  limitSource: string;
  ttlSource: string;
}
interface RateLimitPolicy {
  enabled: boolean;
  enabledSource: string;
  tiers: TierPolicy[];
  routes: Array<{ routeId: string; tier: string; limit: number; ttl: number; enabled: boolean }>;
}
interface QueueStats {
  name: string;
  isPaused: boolean;
  counts: Record<string, number>;
  workerCount: number;
}
interface JobDetail {
  id: string;
  name: string;
  status: string;
  attempts: number;
  failedReason: string | null;
  stacktrace: string[];
  data: Record<string, unknown>;
}

let superAdminToken: string;
let tenantAdminToken: string;
let doctorToken: string;

test.beforeAll(async ({ request }) => {
  const [sa, ta, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
  expect(ta, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
  superAdminToken = sa!.token;
  tenantAdminToken = ta!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// CASL denial matrix — all three surfaces are GLOBAL_ADMIN (`manage all`) only
// =============================================================================
test.describe('CASL — ops surfaces deny non-super-admins', () => {
  const READ_ENDPOINTS = [
    '/api/v1/admin/rate-limit',
    '/api/v1/admin/queues',
    '/api/v1/admin/queues/health/redis',
    `/api/v1/admin/queues/${INGEST_QUEUE}/jobs?status=failed`,
    '/api/v1/admin/pstudio/status',
  ];

  for (const url of READ_ENDPOINTS) {
    test(`GET ${url} → 401 unauthenticated, 403 tenant_admin, 403 doctor`, async ({ request }) => {
      const unauth = await request.get(url);
      expect(unauth.status(), `${url} unauthenticated`).toBe(401);

      const ta = await request.get(url, { headers: bearer(tenantAdminToken) });
      expect(ta.status(), `${url} tenant_admin`).toBe(403);

      const doc = await request.get(url, { headers: bearer(doctorToken) });
      expect(doc.status(), `${url} doctor`).toBe(403);
    });
  }

  test('mutations (kill-switch, tier, retry) → 403 for tenant_admin and doctor', async ({ request }) => {
    const attempts: Array<{ label: string; run: (token: string) => Promise<number> }> = [
      {
        label: 'PUT /admin/rate-limit/enabled',
        run: async (token) => (await request.put('/api/v1/admin/rate-limit/enabled', { headers: bearer(token), data: { enabled: false } })).status(),
      },
      {
        label: 'PUT /admin/rate-limit/tiers/strict',
        run: async (token) => (await request.put('/api/v1/admin/rate-limit/tiers/strict', { headers: bearer(token), data: { limit: 5 } })).status(),
      },
      {
        label: `POST /admin/queues/${INGEST_QUEUE}/jobs/nonexistent/retry`,
        run: async (token) =>
          (await request.post(`/api/v1/admin/queues/${INGEST_QUEUE}/jobs/nonexistent/retry`, { headers: bearer(token) })).status(),
      },
    ];

    for (const attempt of attempts) {
      expect(await attempt.run(tenantAdminToken), `${attempt.label} tenant_admin`).toBe(403);
      expect(await attempt.run(doctorToken), `${attempt.label} doctor`).toBe(403);
    }
  });
});

// =============================================================================
// Surface 14 — Rate Limits
// =============================================================================
test.describe.serial('Rate Limits — policy read + round-trips (ends OFF)', () => {
  async function getPolicy(request: APIRequestContext): Promise<RateLimitPolicy> {
    const res = await request.get('/api/v1/admin/rate-limit', { headers: bearer(superAdminToken) });
    expect(res.status(), 'GET /admin/rate-limit').toBe(200);
    return (await res.json()) as RateLimitPolicy;
  }

  test('policy exposes global flag, all four tier baselines and known-route overrides', async ({ request }) => {
    const policy = await getPolicy(request);

    expect(typeof policy.enabled).toBe('boolean');
    expect(['db', 'default']).toContain(policy.enabledSource);

    const tierNames = policy.tiers.map((t) => t.tier).sort();
    expect(tierNames).toEqual(['default', 'heavy', 'relaxed', 'strict']);
    for (const tier of policy.tiers) {
      expect(tier.limit, `${tier.tier} limit`).toBeGreaterThan(0);
      expect(tier.ttl, `${tier.tier} ttl`).toBeGreaterThan(0);
      expect(['db', 'code', 'default']).toContain(tier.limitSource);
    }

    expect(policy.routes.length, 'known throttled routes').toBeGreaterThan(0);
    const login = policy.routes.find((r) => r.routeId === 'auth.login');
    expect(login, 'auth.login override is a known route').toBeTruthy();
  });

  test('kill-switch round-trip: ON → verified → OFF → verified (hand-off state OFF)', async ({ request }) => {
    const on = await request.put('/api/v1/admin/rate-limit/enabled', {
      headers: bearer(superAdminToken),
      data: { enabled: true },
    });
    expect(on.status(), 'PUT enabled=true').toBe(200);
    const onPolicy = (await on.json()) as RateLimitPolicy;
    expect(onPolicy.enabled).toBe(true);
    expect(onPolicy.enabledSource, 'flag now persisted in DB').toBe('db');

    // Independent read-back confirms persistence (not just the mutation echo).
    expect((await getPolicy(request)).enabled).toBe(true);

    const off = await request.put('/api/v1/admin/rate-limit/enabled', {
      headers: bearer(superAdminToken),
      data: { enabled: false },
    });
    expect(off.status(), 'PUT enabled=false').toBe(200);
    expect(((await off.json()) as RateLimitPolicy).enabled).toBe(false);

    const final = await getPolicy(request);
    expect(final.enabled, 'rate limiting MUST end OFF').toBe(false);
  });

  test('strict-tier limit round-trip: bump → db source → restore original value', async ({ request }) => {
    const before = (await getPolicy(request)).tiers.find((t) => t.tier === 'strict')!;
    const bumped = before.limit + 7;

    const put = await request.put('/api/v1/admin/rate-limit/tiers/strict', {
      headers: bearer(superAdminToken),
      data: { limit: bumped },
    });
    expect(put.status(), 'PUT tiers/strict').toBe(200);
    const after = ((await put.json()) as RateLimitPolicy).tiers.find((t) => t.tier === 'strict')!;
    expect(after.limit).toBe(bumped);
    expect(after.limitSource).toBe('db');

    const restore = await request.put('/api/v1/admin/rate-limit/tiers/strict', {
      headers: bearer(superAdminToken),
      data: { limit: before.limit },
    });
    expect(restore.status(), 'restore original strict limit').toBe(200);
    const restored = ((await restore.json()) as RateLimitPolicy).tiers.find((t) => t.tier === 'strict')!;
    expect(restored.limit, 'strict tier restored to pre-test value').toBe(before.limit);
  });
});

// =============================================================================
// Surface 15 — Queues & Jobs
// =============================================================================
test.describe.serial('Queues & Jobs — listing, redis health, failed-job retry', () => {
  let fixtureJobId: string;
  let producer: Queue | undefined;

  test.afterAll(async () => {
    await producer?.close();
  });

  test('GET /admin/queues lists every registered queue with a full counts shape', async ({ request }) => {
    const res = await request.get('/api/v1/admin/queues', { headers: bearer(superAdminToken) });
    expect(res.status()).toBe(200);
    const queues = (await res.json()) as QueueStats[];

    expect(queues.length, 'all registered platform queues').toBeGreaterThanOrEqual(10);
    const names = queues.map((q) => q.name);
    expect(names).toContain('AuditLog');
    expect(names).toContain(INGEST_QUEUE);

    for (const q of queues) {
      for (const key of ['waiting', 'active', 'completed', 'failed', 'delayed']) {
        expect(typeof q.counts[key], `${q.name}.counts.${key}`).toBe('number');
      }
      expect(typeof q.isPaused, `${q.name}.isPaused`).toBe('boolean');
    }
  });

  test('GET /admin/queues/health/redis reports a live connection', async ({ request }) => {
    const res = await request.get('/api/v1/admin/queues/health/redis', { headers: bearer(superAdminToken) });
    expect(res.status()).toBe(200);
    const health = (await res.json()) as {
      status: string;
      latencyMs: number;
      queuesRegistered: number;
      version: string;
      uptime: number;
    };

    expect(['healthy', 'degraded'], 'test redis is reachable').toContain(health.status);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.queuesRegistered).toBeGreaterThanOrEqual(10);
    expect(health.version, 'redis version surfaced').not.toBe('unknown');
    expect(health.uptime).toBeGreaterThan(0);
  });

  test('a real enqueued job surfaces in listing + counts, then retry re-runs it', async ({ request }) => {
    test.setTimeout(60_000);

    // Enqueue a synthetic poisoned job straight into the test Redis (bullmq
    // producer, same connection the API uses per .env.test). The payload is
    // missing `tenantId`, so IngestKnowledgeDocumentProcessor's fail-closed
    // guard throws immediately — BEFORE any DB or harness access. attempts:1
    // makes it land in `failed` on the first pass; removeOnFail mirrors the
    // platform default so the fixture ages out naturally.
    producer = new Queue(INGEST_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6380),
        password: process.env.REDIS_PASS,
      },
    });
    const job = await producer.add(
      FIXTURE_JOB_NAME,
      { knowledgeDocumentId: `task403-fixture-${Date.now()}`, text: 'task403 fixture' },
      { attempts: 1, removeOnFail: 200 },
    );
    fixtureJobId = job.id!;
    expect(fixtureJobId).toBeTruthy();

    const detailUrl = `/api/v1/admin/queues/${INGEST_QUEUE}/jobs/${fixtureJobId}`;

    // Poll until the worker inside :8868 consumes and fails it.
    await expect
      .poll(
        async () => {
          const res = await request.get(detailUrl, { headers: bearer(superAdminToken) });
          if (res.status() !== 200) return 'pending';
          return ((await res.json()) as JobDetail).status;
        },
        { message: 'fixture job should fail via the tenantId guard', timeout: 30_000 },
      )
      .toBe('failed');

    // Detail carries the guard's reason + a stacktrace and exactly 1 attempt.
    const detailRes = await request.get(detailUrl, { headers: bearer(superAdminToken) });
    const detail = (await detailRes.json()) as JobDetail;
    expect(detail.failedReason ?? '').toContain('missing required tenantId');
    expect(detail.stacktrace.length).toBeGreaterThan(0);
    expect(detail.attempts).toBe(1);
    expect(detail.name).toBe(FIXTURE_JOB_NAME);

    // The failed listing reflects the real job…
    const listRes = await request.get(`/api/v1/admin/queues/${INGEST_QUEUE}/jobs?status=failed&page=0&limit=50`, {
      headers: bearer(superAdminToken),
    });
    expect(listRes.status()).toBe(200);
    const listing = (await listRes.json()) as { items: Array<{ id: string; status?: string }>; total: number };
    expect(listing.total).toBeGreaterThanOrEqual(1);
    expect(
      listing.items.map((j) => j.id),
      'fixture job visible in failed listing',
    ).toContain(fixtureJobId);

    // …and so do the queue-level counts.
    const statsRes = await request.get(`/api/v1/admin/queues/${INGEST_QUEUE}`, { headers: bearer(superAdminToken) });
    const stats = (await statsRes.json()) as QueueStats;
    expect(stats.counts.failed, 'queue counts reflect the enqueued fixture').toBeGreaterThanOrEqual(1);

    // Retry transitions it out of failed; the guard fails it again, so the
    // proof of a genuine re-run is attempts 1 → 2.
    const retryRes = await request.post(`${detailUrl}/retry`, { headers: bearer(superAdminToken) });
    expect(retryRes.status(), 'POST retry').toBe(200);
    expect(((await retryRes.json()) as { success: boolean }).success).toBe(true);

    await expect
      .poll(
        async () => {
          const res = await request.get(detailUrl, { headers: bearer(superAdminToken) });
          if (res.status() !== 200) return -1;
          return ((await res.json()) as JobDetail).attempts;
        },
        { message: 'retry should re-run the job (attemptsMade 1 → 2)', timeout: 30_000 },
      )
      .toBe(2);
  });

  test('retry of a nonexistent job → 404 (not a silent success)', async ({ request }) => {
    const res = await request.post(`/api/v1/admin/queues/${INGEST_QUEUE}/jobs/task403-no-such-job/retry`, {
      headers: bearer(superAdminToken),
    });
    expect(res.status()).toBe(404);
  });
});

// =============================================================================
// Surface 16 — Prisma Studio
// =============================================================================
test.describe('Prisma Studio — status probe honest about availability', () => {
  // The gate is the ENABLE_PRISMA_STUDIO flag alone
  // (production-capable, fail-closed when unset). `.env.test` does not set
  // the flag, so the probe must report disabled and the shell must be absent.
  test('GET /admin/pstudio/status reports enabled:false when ENABLE_PRISMA_STUDIO is unset', async ({ request }) => {
    const res = await request.get('/api/v1/admin/pstudio/status', { headers: bearer(superAdminToken) });
    expect(res.status()).toBe(200);
    expect((await res.json()) as { enabled: boolean }).toEqual({ enabled: false });
  });

  test('the Studio shell itself is genuinely absent (404) when disabled', async ({ request }) => {
    const res = await request.get('/api/v1/admin/pstudio', { headers: bearer(superAdminToken) });
    expect(res.status(), 'conditional PrismaStudioModule not registered in test env').toBe(404);
  });
});
