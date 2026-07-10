/**
 * Cross-tenant probes against StorageController (AC-9).
 *
 * Originally landed by TASK-307 W3.6 closing audit finding C-2
 * (BLOCKER, `04-api-design-review.md`). The controller historically
 * resolved any free-form `:name` directly to `s3Service.{getFile,
 * deleteBucket,…}` with only a path-traversal regex for hygiene; a
 * tenant-A user with the `delete:Storage` CASL permission could
 * enumerate every known bucket suffix (`hope-recordings-<tenant>`,
 * `hope-attachments-<tenant>`) and delete or download tenant-B
 * contents.
 *
 * After the W3 fix the global interceptor reads
 * `@TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name',
 * lookup: 'name' })` and resolves the name via
 * `TenantBucketRepository.findByName` (only ENABLED system/custom
 * rows). Any name without a matching `TenantBucket` row, or owned by
 * a different tenant, yields 404 — never 200. The DEF-C3 wording
 * ("Resource not found") keeps every shape of failure
 * indistinguishable from a missing bucket.
 *
 * TASK-309 AC-2 / AC-3 — genuine probe strengthening. This spec was
 * already using real bucket NAMES (the seed in
 * `05a-tenant-bucket.ts` ships `hope-recordings-<tenant>` and
 * `hope-attachments-<tenant>` for every customer tenant), so the
 * cross-tenant 404s prove the interceptor logic and not just a
 * missing-bucket short-circuit. The upgrade in this revision is to
 * EXPLICITLY confirm that the ARCAAI recordings + attachments buckets
 * exist (visible to the ARCAAI-scoped super_admin) BEFORE the
 * __GLOBAL__ tenant_admin probes them — without this, a regression
 * that accidentally deleted the seed buckets would silently turn
 * "cross-tenant 404" into "missing-bucket 404" and erase the test's
 * meaning.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const ARCAAI_RECORDINGS_BUCKET = 'hope-recordings-arcaai'; // matches seed/05a-tenant-bucket (TASK-426: recordings)
const ARCAAI_ATTACHMENTS_BUCKET = 'hope-attachments-arcaai';

interface BucketRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
}

test.describe('TASK-309 AC-2/AC-3 — Storage bucket ownership genuine probe (AC-9)', () => {
  let tenantAdminToken: string;
  let superAdminArcaaiToken: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
    tenantAdminToken = ta!.token;

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super_admin login (ARCAAI) failed').toBeTruthy();
    superAdminArcaaiToken = sa!.token;

    // TASK-309: assert the ARCAAI seed actually shipped the bucket
    // we're about to probe. If the seed regresses (e.g. someone
    // deletes tenant-bucket seeds) the cross-tenant 404 below
    // would silently turn into a missing-bucket 404 and the test
    // would no longer prove ownership enforcement.
    const arcaaiBuckets = await request.get('/api/v1/admin/tenants/storage/buckets', {
      headers: { Authorization: `Bearer ${superAdminArcaaiToken}` },
    });
    expect(arcaaiBuckets.status(), 'list ARCAAI buckets').toBe(200);
    const rows = (await arcaaiBuckets.json()) as BucketRow[];
    const recordings = rows.find((b) => b.name === ARCAAI_RECORDINGS_BUCKET);
    const attachments = rows.find((b) => b.name === ARCAAI_ATTACHMENTS_BUCKET);
    expect(
      recordings,
      `ARCAAI seed must include "${ARCAAI_RECORDINGS_BUCKET}" — without this the cross-tenant probe degrades to "missing bucket"`,
    ).toBeTruthy();
    expect(attachments, `ARCAAI seed must include "${ARCAAI_ATTACHMENTS_BUCKET}"`).toBeTruthy();
  });

  test('GET /storage/buckets/:name probing ARCAAI bucket from __GLOBAL__ → 404', async ({ request }) => {
    const response = await request.get(`/api/v1/storage/buckets/${ARCAAI_RECORDINGS_BUCKET}`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });

  test('GET /storage/buckets/:name/files probing ARCAAI bucket from __GLOBAL__ → 404', async ({ request }) => {
    const response = await request.get(`/api/v1/storage/buckets/${ARCAAI_RECORDINGS_BUCKET}/files`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });

  test('DELETE /storage/buckets/:name probing ARCAAI bucket from __GLOBAL__ → 404 (bucket still exists)', async ({ request }) => {
    // Cross-tenant DELETE attempt by tenant_admin in __GLOBAL__.
    const response = await request.delete(`/api/v1/storage/buckets/${ARCAAI_ATTACHMENTS_BUCKET}`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(response.status()).toBe(404);

    // Bucket must still be enumerable from ARCAAI's super_admin —
    // proves the 404 was a guard rejection, not an actual delete.
    const after = await request.get('/api/v1/admin/tenants/storage/buckets', { headers: { Authorization: `Bearer ${superAdminArcaaiToken}` } });
    expect(after.status()).toBe(200);
    const rows = (await after.json()) as BucketRow[];
    expect(rows.some((b) => b.name === ARCAAI_ATTACHMENTS_BUCKET)).toBe(true);
  });

  test('GET /storage/buckets/:name/files/:key on ARCAAI bucket from __GLOBAL__ → 404 (no presigned-URL leak)', async ({ request }) => {
    const response = await request.get(`/api/v1/storage/buckets/${ARCAAI_RECORDINGS_BUCKET}/files/anything.wav`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('http');
  });

  test('GET /storage/buckets/:name on an unknown free-form name → 404 (drops the legacy C-2 leak)', async ({ request }) => {
    const response = await request.get('/api/v1/storage/buckets/some-arbitrary-bucket-that-does-not-exist', {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });
});
