/**
 * TASK-308 AC-4 — same-tenant cross-user probes against
 * `ConsultationJobController.cancel`.
 *
 * Pins the AC-2 + AC-3 contract end-to-end:
 *
 *   - tenant-A user-1 (the job's creator) cancels their own job → 200
 *   - tenant-A user-2 (a same-tenant peer)                cancels → 404
 *   - tenant-A user-2 GETs the same job                            → 200
 *     (read routes deliberately stay tenant-only; see README §1.3 AC-2)
 *
 * Cross-TENANT 404 behaviour is already proven by
 * `task-307-consultation-job-cross-tenant.spec.ts` (TASK-307 W3.4) — we
 * don't re-prove it here. The TASK-308 §1.3 AC-4 reference to "tenant-B
 * user → 404" is satisfied by that prior spec PLUS the
 * `cross-tenant probe regardless of scope:"creator"` unit test in
 * `apps/api/src/common/__tests__/tenant-owned-resource.interceptor.test.ts`
 * (TASK-308 AC-3).
 *
 * Test data
 * ---------
 * The E2E stack does not normally produce a real `ConsultationJobStatus`
 * row (that would require driving the full BullMQ + SMR pipeline), so we
 * seed Redis directly with the same JSON shape the W3.3 `JobService`
 * writes. Cleanup deletes the key in `afterAll`.
 *
 *   Redis key  : `consultation_job:<jobId>`
 *   JSON shape : `ConsultationJobStatus` from
 *                `packages/applications/src/services/consultation/jobs/dto/job.dto.ts`
 *
 * Requires the dev/test stack (`docker compose up postgres redis`) +
 * seeded fixtures (`pnpm test:db:seed`). `REDIS_HOST` / `REDIS_PORT` /
 * `REDIS_PASS` from the API's `.env.test` are reused.
 *
 * If Redis is unreachable the seeding block throws and Playwright reports
 * a clear setup failure — the spec does NOT silently degrade into a no-op.
 */
import { test, expect } from '@playwright/test';
import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const JOB_KEY_PREFIX = 'consultation_job:';

/** Build a `ConsultationJobStatus` row that mirrors `JobService` exactly. */
function buildJobStatusJson(opts: { jobId: string; tenantId: string; userId: string }) {
    return JSON.stringify({
        jobId: opts.jobId,
        type: 'SUMMARY',
        status: 'RUNNING',
        consultationId: 'e2e-consultation-308',
        progress: 42,
        currentStep: 'seeded-for-test',
        createdAt: new Date('2026-05-28T00:00:00Z').toISOString(),
        startedAt: new Date('2026-05-28T00:00:01Z').toISOString(),
        tenantId: opts.tenantId,
        userId: opts.userId,
    });
}

function buildRedisClient(): Redis {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT || '6379');
    const password = process.env.REDIS_PASS || undefined;
    return new Redis({
        host,
        port,
        password,
        // Fail fast in CI / when the dev stack is down rather than hanging
        // for the default 10 retries.
        maxRetriesPerRequest: 1,
        // Eager — surface the connection error during the seeding block.
        lazyConnect: false,
    });
}

test.describe('TASK-308 AC-4 — ConsultationJob cancel ownership (intra-tenant)', () => {
    // Both doctors live in DEFAULT_TENANT_KEY (`__GLOBAL__`); see
    // packages/database/src/prisma/db_main/seed/91-user.ts.
    let creatorToken: string;
    let peerToken: string;
    let tenantId: string;

    // Use a fresh uuidv7 per file run so reruns don't collide with stale
    // Redis state from prior aborted runs.
    const jobId = uuidv7();

    let redis: Redis | null = null;

    test.beforeAll(async ({ request }) => {
        const creatorLogin = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(creatorLogin, 'doctor (creator) login failed').toBeTruthy();
        creatorToken = creatorLogin!.token;

        const peerLogin = await loginUser(
            request,
            SEEDED_USERS.doctor2.username,
            SEEDED_USERS.doctor2.password,
            DEFAULT_TENANT_KEY,
        );
        expect(peerLogin, 'doctor2 (same-tenant peer) login failed').toBeTruthy();
        peerToken = peerLogin!.token;

        // Both tokens carry the same active tenantId — confirm by decoding
        // doctor's JWT payload so the spec doesn't quietly seed against the
        // wrong tenant.
        const payload = JSON.parse(Buffer.from(creatorToken.split('.')[1], 'base64url').toString('utf8'));
        expect(payload.tenantId, 'creator JWT missing tenantId').toBeTruthy();
        tenantId = payload.tenantId as string;

        const peerPayload = JSON.parse(Buffer.from(peerToken.split('.')[1], 'base64url').toString('utf8'));
        expect(peerPayload.tenantId, 'peer must share creator tenantId').toBe(tenantId);
        expect(peerPayload.id, 'peer userId differs from creator').not.toBe(payload.id);

        redis = buildRedisClient();
        await redis.set(
            `${JOB_KEY_PREFIX}${jobId}`,
            buildJobStatusJson({
                jobId,
                tenantId,
                userId: SEEDED_USERS.doctor.id, // creator
            }),
        );
    });

    test.afterAll(async () => {
        if (redis) {
            try {
                await redis.del(`${JOB_KEY_PREFIX}${jobId}`);
            } finally {
                await redis.quit();
            }
        }
    });

    // -----------------------------------------------------------------------
    // AC-4 case 1 — same-tenant peer cannot CANCEL the creator's job.
    // This is the audit C-4 / W7.A.12 finding the ticket exists to close.
    // -----------------------------------------------------------------------
    test('PATCH /consultations/jobs/:jobId/cancel — same-tenant cross-user returns 404', async ({ request }) => {
        const response = await request.patch(`/api/v1/consultations/jobs/${jobId}/cancel`, {
            headers: { Authorization: `Bearer ${peerToken}` },
        });
        expect(response.status()).toBe(404);
        const body = await response.json();
        // DEF-C3 no-existence-leak — the 404 must not betray that the job
        // actually exists in another user's namespace.
        expect(String(body.message ?? '').toLowerCase()).not.toContain('owner');
        expect(String(body.message ?? '').toLowerCase()).not.toContain('user');
    });

    // -----------------------------------------------------------------------
    // AC-4 case 2 — read routes deliberately stay tenant-only. A same-tenant
    // peer may READ the job (e.g. shared consultation room).
    // -----------------------------------------------------------------------
    test('GET /consultations/jobs/:jobId — same-tenant peer can READ (read route is tenant-only)', async ({
        request,
    }) => {
        const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${peerToken}` },
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.jobId).toBe(jobId);
        expect(body.userId).toBe(SEEDED_USERS.doctor.id);
        expect(body.tenantId).toBe(tenantId);
    });

    // -----------------------------------------------------------------------
    // AC-4 case 3 — the creator can still cancel their own job (the W3 +
    // W7.A.12 guard didn't accidentally lock out the rightful owner).
    //
    // Runs LAST in the file because the cancel flips the status to
    // CANCELLED in the same Redis row case 1+2 read; running case 1
    // before this ensures the peer 404 was on a still-RUNNING job, not on
    // a terminal one.
    // -----------------------------------------------------------------------
    test('PATCH /consultations/jobs/:jobId/cancel — creator can cancel their own job (200)', async ({ request }) => {
        const response = await request.patch(`/api/v1/consultations/jobs/${jobId}/cancel`, {
            headers: { Authorization: `Bearer ${creatorToken}` },
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ ok: true });
    });
});
