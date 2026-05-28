/**
 * TASK-307 W3.9 — aggregator suite for the W3 cross-tenant decorator rollout.
 *
 * Provides a single, end-to-end audit pass that touches every endpoint the
 * `@TenantOwnedResource(...)` decorator now protects, so reviewers and CI
 * dashboards can verify the closure of audit C-2, C-3, C-4, C-5, and D-3
 * in one suite. The per-controller specs
 * (`task-307-{consultation-job,tenant-bucket,storage,voice-profile,
 *  transcription-job}-cross-tenant.spec.ts`) carry the deeper assertions;
 * this file only confirms each protected route returns 404 (not 200 / 500)
 * for an out-of-tenant probe.
 *
 * Filter: `pnpm test:e2e -g "TASK-307 W3"` matches this file plus the five
 * per-controller specs in the same directory.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

interface ProbeCase {
    name: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    /** Acceptable response shapes — 404 is preferred (DEF-C3 no-existence-leak). */
    expectStatuses: ReadonlyArray<number>;
}

const UUIDV7_PROBE = '018f0000-0000-7900-8000-000000000000';

const CASES: ReadonlyArray<ProbeCase> = [
    {
        name: 'W3.4 — GET consultations/jobs/:jobId',
        method: 'GET',
        path: `/api/v1/consultations/jobs/${UUIDV7_PROBE}`,
        expectStatuses: [404],
    },
    {
        name: 'W3.4 — PATCH consultations/jobs/:jobId/cancel',
        method: 'PATCH',
        path: `/api/v1/consultations/jobs/${UUIDV7_PROBE}/cancel`,
        expectStatuses: [404],
    },
    {
        name: 'W3.5 — GET admin/tenants/storage/buckets/:id',
        method: 'GET',
        path: `/api/v1/admin/tenants/storage/buckets/${UUIDV7_PROBE}`,
        expectStatuses: [404],
    },
    {
        name: 'W3.5 — DELETE admin/tenants/storage/buckets/:id',
        method: 'DELETE',
        path: `/api/v1/admin/tenants/storage/buckets/${UUIDV7_PROBE}`,
        expectStatuses: [404],
    },
    {
        name: 'W3.6 — GET storage/buckets/:name',
        method: 'GET',
        path: '/api/v1/storage/buckets/hope-audio-arcaai',
        expectStatuses: [404],
    },
    {
        name: 'W3.6 — DELETE storage/buckets/:name',
        method: 'DELETE',
        path: '/api/v1/storage/buckets/hope-attachments-arcaai',
        expectStatuses: [404],
    },
    {
        name: 'W3.7 — PATCH voice-profile/:id/activate',
        method: 'PATCH',
        path: `/api/v1/voice-profile/${UUIDV7_PROBE}/activate`,
        expectStatuses: [404],
    },
    {
        name: 'W3.7 — DELETE voice-profile/:id',
        method: 'DELETE',
        path: `/api/v1/voice-profile/${UUIDV7_PROBE}`,
        expectStatuses: [404],
    },
    {
        name: 'W3.8 — GET audio/transcription-jobs/:id',
        method: 'GET',
        path: `/api/v1/audio/transcription-jobs/${UUIDV7_PROBE}`,
        expectStatuses: [404],
    },
    {
        name: 'W3.8 — POST audio/transcription-jobs/:id/cancel',
        method: 'POST',
        path: `/api/v1/audio/transcription-jobs/${UUIDV7_PROBE}/cancel`,
        expectStatuses: [404],
    },
];

async function probe(
    request: APIRequestContext,
    token: string,
    c: ProbeCase,
): Promise<number> {
    const headers = { Authorization: `Bearer ${token}` };
    switch (c.method) {
        case 'GET':
            return (await request.get(c.path, { headers })).status();
        case 'POST':
            return (await request.post(c.path, { headers, data: {} })).status();
        case 'PATCH':
            return (await request.patch(c.path, { headers, data: {} })).status();
        case 'DELETE':
            return (await request.delete(c.path, { headers })).status();
    }
}

test.describe('TASK-307 W3.9 — aggregate cross-tenant audit', () => {
    let doctorToken: string;

    test.beforeAll(async ({ request }) => {
        const login = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(login, 'doctor login (tenant __GLOBAL__) failed').toBeTruthy();
        doctorToken = login!.token;
    });

    for (const c of CASES) {
        test(c.name, async ({ request }) => {
            const status = await probe(request, doctorToken, c);
            expect(c.expectStatuses).toContain(status);
        });
    }
});
