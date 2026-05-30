/**
 * TASK-219: Admin Panel E2E Gap Tests
 *
 * Tests for implementation gaps identified in TASK-219 (remaining after module removal):
 * - A1: PATCH /admin/rbac/roles/{id}
 * - A2: PATCH /admin/rbac/policies/{id}
 * - A6: Fix PATCH /admin/tenants/configs/{identifier}
 * - A7: PATCH /storage/buckets/{name} with resourceStatus
 * - A8: GET /admin/tenants/{id}/usage
 */

import { test, expect } from '@playwright/test';
import {
  createTestDataRegistry,
  loginSeededUsers,
  loginUser,
  cleanupTestData,
  DEFAULT_TENANT_KEY,
  SEEDED_USERS,
  type TestDataRegistry,
} from '../../../../tests/helpers';

const TENANT_ID = '50000000-0000-0000-0000-000000000001';

test.describe('TASK-219: Admin Panel Gaps', () => {
  let superAdminToken: string;
  const testDataRegistry: TestDataRegistry = createTestDataRegistry();

  test.beforeAll(async ({ request }) => {
    const tokens = await loginSeededUsers(request);
    superAdminToken = tokens.superAdminToken ?? '';
    expect(superAdminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!superAdminToken) return;

    await cleanupTestData(request, superAdminToken, testDataRegistry);
  });

  // ==========================================================================
  // A1: PATCH /admin/rbac/roles/{id} — partial update support
  // ==========================================================================

  test.describe('A1: PATCH /admin/rbac/roles/{id}', () => {
    let testRoleId: string;

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/v1/admin/rbac/roles', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          name: `task219-role-${Date.now()}`,
          description: 'Test role for TASK-219 PATCH',
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      testRoleId = body.id;
      testDataRegistry.roles.push(testRoleId);
    });

    test('should update role name via PATCH', async ({ request }) => {
      const newName = `task219-role-renamed-${Date.now()}`;
      const res = await request.patch(`/api/v1/admin/rbac/roles/${testRoleId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { name: newName },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.name).toBe(newName);
    });

    test('should update role description only via PATCH', async ({ request }) => {
      const res = await request.patch(`/api/v1/admin/rbac/roles/${testRoleId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { description: 'Updated description only' },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.description).toBe('Updated description only');
    });

    test('should disable role via PATCH with resourceStatus', async ({ request }) => {
      const res = await request.patch(`/api/v1/admin/rbac/roles/${testRoleId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { resourceStatus: 'DISABLED' },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.resourceStatus).toBe('DISABLED');
    });

    test('should re-enable role via PATCH with resourceStatus', async ({ request }) => {
      const res = await request.patch(`/api/v1/admin/rbac/roles/${testRoleId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { resourceStatus: 'ENABLED' },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.resourceStatus).toBe('ENABLED');
    });

    test('should return 404 for non-existent role', async ({ request }) => {
      const res = await request.patch('/api/v1/admin/rbac/roles/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { name: 'nope' },
      });
      expect(res.status()).toBe(404);
    });
  });

  // ==========================================================================
  // A2: PATCH /admin/rbac/policies/{id} — partial update support
  // ==========================================================================

  test.describe('A2: PATCH /admin/rbac/policies/{id}', () => {
    let testPolicyId: string;

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/v1/admin/rbac/policies', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          name: `task219-policy-${Date.now()}`,
          description: 'Test policy for TASK-219 PATCH',
          scope: 'TENANT',
          rules: [{ action: 'read', subject: 'TestResource' }],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      testPolicyId = body.id;
      testDataRegistry.policies.push(testPolicyId);
    });

    test('should update policy description via PATCH', async ({ request }) => {
      const res = await request.patch(`/api/v1/admin/rbac/policies/${testPolicyId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { description: 'Patched description' },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.description).toBe('Patched description');
    });

    test('should update policy rules via PATCH', async ({ request }) => {
      const res = await request.patch(`/api/v1/admin/rbac/policies/${testPolicyId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          rules: [
            { action: 'read', subject: 'TestResource' },
            { action: 'create', subject: 'TestResource' },
          ],
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.rules).toHaveLength(2);
    });

    test('should return 404 for non-existent policy', async ({ request }) => {
      const res = await request.patch('/api/v1/admin/rbac/policies/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { name: 'nope' },
      });
      expect(res.status()).toBe(404);
    });
  });

  // ==========================================================================
  // A7: PATCH /storage/buckets/{name} with resourceStatus
  // ==========================================================================

  test.describe('A7: PATCH /storage/buckets/{name}', () => {
    const bucketName = `task219-bucket-${Date.now()}`;
    // The storage management routes are tenant-owned (@TenantOwnedResource,
    // no super-admin bypass — TASK-307 W3.2): a super_admin WITHOUT a tenant
    // context 404s on PATCH/DELETE because there is no tenant to match. Use a
    // tenant-scoped super_admin so POST registers a TenantBucket row owned by a
    // real tenant and the ownership interceptor can resolve it on PATCH.
    let storageToken: string;

    test.beforeAll(async ({ request }) => {
      const login = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
        DEFAULT_TENANT_KEY,
      );
      expect(login, 'tenant-scoped super_admin login failed').toBeTruthy();
      storageToken = login!.token;

      const res = await request.post('/api/v1/storage/buckets', {
        headers: { Authorization: `Bearer ${storageToken}` },
        data: { name: bucketName },
      });
      expect(res.status()).toBe(201);
    });

    test.afterAll(async ({ request }) => {
      if (!storageToken) return;
      await request.delete(`/api/v1/storage/buckets/${bucketName}`, {
        headers: { Authorization: `Bearer ${storageToken}` },
      });
    });

    test('should update bucket via PATCH', async ({ request }) => {
      const res = await request.patch(`/api/v1/storage/buckets/${bucketName}`, {
        headers: { Authorization: `Bearer ${storageToken}` },
        data: { description: 'Updated bucket description' },
      });
      expect(res.status()).toBe(200);
    });

    test('should disable bucket via PATCH with resourceStatus', async ({ request }) => {
      const res = await request.patch(`/api/v1/storage/buckets/${bucketName}`, {
        headers: { Authorization: `Bearer ${storageToken}` },
        data: { resourceStatus: 'DISABLED' },
      });
      expect(res.status()).toBe(200);
    });
  });

  // ==========================================================================
  // A8: GET /admin/tenants/{id}/usage
  // ==========================================================================

  test.describe('A8: GET /admin/tenants/{id}/usage', () => {
    test('should return tenant usage statistics', async ({ request }) => {
      const res = await request.get(`/api/v1/admin/tenants/${TENANT_ID}/usage`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('totalUsers');
      expect(body).toHaveProperty('totalDepartments');
    });
  });
});
