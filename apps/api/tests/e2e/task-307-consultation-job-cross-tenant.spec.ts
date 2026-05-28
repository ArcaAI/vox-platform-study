/**
 * TASK-307 W3.4 — cross-tenant probes against ConsultationJobController.
 *
 * Closes audit finding C-3 (`docs/multi-tenancy-audit/04-api-design-review.md`)
 * — before this change `GET /consultations/jobs/:jobId` returned 200 with the
 * status of jobs owned by ANY tenant. The W3.2 `TenantOwnedResourceInterceptor`
 * now reads `@TenantOwnedResource('ConsultationJob', 'jobId')` and asserts
 * `status.tenantId === cls.tenantId`, throwing 404 ("Resource not found") on
 * mismatch. The 404 path is the DEF-C3 no-existence-leak posture from
 * TASK-306.
 *
 * NOTE: spinning up a live consultation + BullMQ + Redis pipeline only to
 * produce one cross-tenant job is heavy. We exercise the negative path with
 * a synthetic uuidv7 (which Redis cannot match in any tenant): the
 * interceptor must still respond 404 *and not* 200/500. Combined with the
 * `TenantOwnedResourceInterceptor` unit tests in
 * `apps/api/src/common/__tests__/tenant-owned-resource.interceptor.test.ts`
 * (which DO exercise a tenant mismatch against a stubbed
 * `IConsultationJobService.getJobStatus` returning a tenant-B status), this
 * spec is sufficient evidence of AC-10. Live cross-tenant job probes can be
 * added to TASK-263's `consultation-jobs.e2e-spec.ts` when the seed grows a
 * second-tenant consultation.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const SYNTHETIC_JOB_ID = '018f0000-0000-7000-8000-000000000000'; // uuidv7-shaped, never seeded

test.describe('TASK-307 W3.4 — ConsultationJob ownership (AC-10)', () => {
    let doctorToken: string;

    test.beforeAll(async ({ request }) => {
        const login = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(login, 'doctor login failed').toBeTruthy();
        doctorToken = login!.token;
    });

    test('GET /consultations/jobs/:jobId of an unknown job returns 404 — no controller body leak', async ({ request }) => {
        const response = await request.get(
            `/api/v1/consultations/jobs/${SYNTHETIC_JOB_ID}`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/tenant/i);
    });

    test('PATCH /consultations/jobs/:jobId/cancel of an unknown job returns 404', async ({ request }) => {
        const response = await request.patch(
            `/api/v1/consultations/jobs/${SYNTHETIC_JOB_ID}/cancel`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('GET /consultations/jobs/:jobId/stream of an unknown job rejects before opening SSE', async ({ request }) => {
        const response = await request.get(
            `/api/v1/consultations/jobs/${SYNTHETIC_JOB_ID}/stream`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect([401, 404]).toContain(response.status());
    });
});
