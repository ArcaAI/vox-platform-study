/**
 * TASK-307 W3.5 — cross-tenant probes against TenantBucketController.
 *
 * Closes audit finding C-4 (`docs/multi-tenancy-audit/04-api-design-review.md`):
 * before this change, `GET /admin/tenants/storage/buckets/:id` and the sister
 * tree / presigned-url / delete routes returned 200 with the bucket payload
 * regardless of which tenant owned the row — any TENANT_ADMIN with manage
 * privileges could enumerate every other tenant's buckets by id.
 *
 * The W3.2 global `TenantOwnedResourceInterceptor`, driven by the
 * `@TenantOwnedResource('TenantBucket', 'id')` decorator added in this
 * commit, resolves the bucket via
 * `TenantBucketRepository.findById` and throws 404 ("Resource not found")
 * whenever `bucket.tenantId !== cls.tenantId`. The DEF-C3 posture keeps the
 * 404 generic so the existence of cross-tenant buckets remains private.
 *
 * Test scenario — every seed environment ships system buckets for every
 * tenant (`05a-tenant-bucket.ts`):
 *   - super_admin → discovers tenant ARCAAI's `recordings` bucket id.
 *   - tenant_admin (in `__GLOBAL__`) probes that id → must respond 404.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const SYNTHETIC_BUCKET_ID = '018f0000-0000-7100-8000-000000000000';

interface BucketRow {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
}

test.describe('TASK-307 W3.5 — TenantBucket ownership (AC-8)', () => {
    let superAdminToken: string;
    let tenantAdminToken: string;
    let arcaaiBucketId: string;

    test.beforeAll(async ({ request }) => {
        const sa = await loginUser(
            request,
            SEEDED_USERS.superAdmin.username,
            SEEDED_USERS.superAdmin.password,
            'ARCAAI',
        );
        expect(sa, 'super_admin login (ARCAAI) failed').toBeTruthy();
        superAdminToken = sa!.token;

        const ta = await loginUser(
            request,
            SEEDED_USERS.admin.username,
            SEEDED_USERS.admin.password,
            DEFAULT_TENANT_KEY,
        );
        expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
        tenantAdminToken = ta!.token;

        // Discover a real bucket id in tenant ARCAAI via the super-admin scope.
        const listResp = await request.get(
            '/api/v1/admin/tenants/storage/buckets',
            { headers: { Authorization: `Bearer ${superAdminToken}` } },
        );
        expect(listResp.status(), 'list ARCAAI buckets').toBe(200);
        const rows = (await listResp.json()) as BucketRow[];
        // TASK-426 — the default audio-purpose system slug is `recordings`.
        const recordings = rows.find((b) => b.slug === 'recordings');
        expect(recordings, 'ARCAAI seed should ship a recordings bucket').toBeTruthy();
        arcaaiBucketId = recordings!.id;
    });

    test('tenant_admin from __GLOBAL__ probing ARCAAI bucket by id → 404 (no 200 leak)', async ({ request }) => {
        const response = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/tenant/i);
    });

    test('tenant_admin from __GLOBAL__ probing ARCAAI bucket tree by id → 404', async ({ request }) => {
        const response = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}/tree`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('tenant_admin from __GLOBAL__ probing ARCAAI presigned URL by id → 404', async ({ request }) => {
        const response = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}/presigned-url?key=irrelevant`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('tenant_admin from __GLOBAL__ deleting ARCAAI bucket by id → 404 (and ARCAAI bucket still exists)', async ({ request }) => {
        const before = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}`,
            { headers: { Authorization: `Bearer ${superAdminToken}` } },
        );
        expect(before.status()).toBe(200);

        const response = await request.delete(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);

        const after = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${arcaaiBucketId}`,
            { headers: { Authorization: `Bearer ${superAdminToken}` } },
        );
        expect(after.status()).toBe(200);
    });

    test('synthetic uuidv7 bucket id → 404 (DEF-C3: same shape as cross-tenant 404)', async ({ request }) => {
        const response = await request.get(
            `/api/v1/admin/tenants/storage/buckets/${SYNTHETIC_BUCKET_ID}`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });
});
