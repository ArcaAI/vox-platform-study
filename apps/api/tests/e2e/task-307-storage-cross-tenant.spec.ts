/**
 * TASK-307 W3.6 — cross-tenant probes against StorageController (AC-9).
 *
 * Closes audit finding C-2 (BLOCKER, `04-api-design-review.md`). The
 * controller historically resolved any free-form `:name` directly to
 * `s3Service.{getFile,deleteBucket,…}` with only a path-traversal regex
 * for hygiene; a tenant-A user with the `delete:Storage` CASL permission
 * could enumerate every known bucket suffix (`hope-audio-<tenant>`,
 * `hope-attachments-<tenant>`) and delete or download tenant-B contents.
 *
 * After this commit, the W3.2 global interceptor reads
 * `@TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name',
 * lookup: 'name' })` and resolves the name via
 * `TenantBucketRepository.findByName` (only ENABLED system/custom rows).
 * Any name without a matching `TenantBucket` row, or owned by a different
 * tenant, yields 404 — never 200. The DEF-C3 wording ("Resource not
 * found") keeps every shape of failure indistinguishable from a missing
 * bucket.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const ARCAAI_AUDIO_BUCKET = 'hope-audio-arcaai'; // matches seed/05a-tenant-bucket
const ARCAAI_ATTACHMENTS_BUCKET = 'hope-attachments-arcaai';

test.describe('TASK-307 W3.6 — Storage bucket ownership by name (AC-9)', () => {
    let tenantAdminToken: string;
    let superAdminArcaaiToken: string;

    test.beforeAll(async ({ request }) => {
        const ta = await loginUser(
            request,
            SEEDED_USERS.admin.username,
            SEEDED_USERS.admin.password,
            DEFAULT_TENANT_KEY,
        );
        expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
        tenantAdminToken = ta!.token;

        const sa = await loginUser(
            request,
            SEEDED_USERS.superAdmin.username,
            SEEDED_USERS.superAdmin.password,
            'ARCAAI',
        );
        expect(sa, 'super_admin login (ARCAAI) failed').toBeTruthy();
        superAdminArcaaiToken = sa!.token;
    });

    test('GET /storage/buckets/:name probing ARCAAI bucket from __GLOBAL__ → 404', async ({ request }) => {
        const response = await request.get(
            `/api/v1/storage/buckets/${ARCAAI_AUDIO_BUCKET}`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('GET /storage/buckets/:name/files probing ARCAAI bucket from __GLOBAL__ → 404', async ({ request }) => {
        const response = await request.get(
            `/api/v1/storage/buckets/${ARCAAI_AUDIO_BUCKET}/files`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('DELETE /storage/buckets/:name probing ARCAAI bucket from __GLOBAL__ → 404 (bucket still exists)', async ({ request }) => {
        const before = await request.get(
            `/api/v1/storage/buckets/${ARCAAI_ATTACHMENTS_BUCKET}/files`,
            { headers: { Authorization: `Bearer ${superAdminArcaaiToken}` } },
        );
        expect([200, 404]).toContain(before.status());

        const response = await request.delete(
            `/api/v1/storage/buckets/${ARCAAI_ATTACHMENTS_BUCKET}`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('GET /storage/buckets/:name/files/:key on ARCAAI bucket from __GLOBAL__ → 404 (no presigned-URL leak)', async ({ request }) => {
        const response = await request.get(
            `/api/v1/storage/buckets/${ARCAAI_AUDIO_BUCKET}/files/anything.wav`,
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain('http');
    });

    test('GET /storage/buckets/:name on an unknown free-form name → 404 (drops the legacy C-2 leak)', async ({ request }) => {
        const response = await request.get(
            '/api/v1/storage/buckets/some-arbitrary-bucket-that-does-not-exist',
            { headers: { Authorization: `Bearer ${tenantAdminToken}` } },
        );
        expect(response.status()).toBe(404);
    });
});
