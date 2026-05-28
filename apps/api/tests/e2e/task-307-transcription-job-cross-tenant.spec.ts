/**
 * TASK-307 W3.8 — cross-tenant probes against TranscriptionJobController
 * (AC-12). Closes audit finding D-3 (`04-api-design-review.md`).
 *
 * Before this change, `GET /audio/transcription-jobs/:id`,
 * `POST /:id/cancel`, `POST /:id/retry`, and the SSE `:id/stream` accepted
 * any id without verifying ownership; the only defense was the TASK-305
 * Prisma `tenantScopeFilter` extension, which super-admins bypass by
 * design.
 *
 * The W3.2 interceptor + `assertTenantScoped` branch resolves the row via
 * `TranscriptionJobRepository.findById` and 404s any caller whose CLS
 * tenantId disagrees with the row's `tenantId`. The list/getByConsultation
 * endpoints get a parallel service-layer guard (W3.8 in
 * `transcriptionJob.service.ts`) so super-admin calls cannot accidentally
 * return cross-tenant rows.
 *
 * Synthetic-id probes are used here because creating a live transcription
 * job requires a multi-service stack (STT-V2 + audio upload). The W3.2
 * interceptor unit tests already exercise a real tenant-mismatch against
 * a stubbed `TranscriptionJobRepository.findById`.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const SYNTHETIC_JOB_ID = '018f0000-0000-7300-8000-000000000000';

test.describe('TASK-307 W3.8 — TranscriptionJob ownership (AC-12)', () => {
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

    test('GET /audio/transcription-jobs/:id of a nonexistent job → 404', async ({ request }) => {
        const response = await request.get(
            `/api/v1/audio/transcription-jobs/${SYNTHETIC_JOB_ID}`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/tenant/i);
    });

    test('POST /audio/transcription-jobs/:id/cancel of a nonexistent job → 404', async ({ request }) => {
        const response = await request.post(
            `/api/v1/audio/transcription-jobs/${SYNTHETIC_JOB_ID}/cancel`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('POST /audio/transcription-jobs/:id/retry of a nonexistent job → 404', async ({ request }) => {
        const response = await request.post(
            `/api/v1/audio/transcription-jobs/${SYNTHETIC_JOB_ID}/retry`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('GET /audio/transcription-jobs/:id/stream of a nonexistent job → 404 (no SSE leak)', async ({ request }) => {
        const response = await request.get(
            `/api/v1/audio/transcription-jobs/${SYNTHETIC_JOB_ID}/stream`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect([401, 404]).toContain(response.status());
    });
});
