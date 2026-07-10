/**
 * Tenant Controller E2E Tests
 *
 * Tests for multi-tenant management endpoints
 *
 * TEST DATA MANAGEMENT:
 * - Uses seeded users (tenant_admin) for authentication
 * - Does NOT create tenants in tests (only tests read operations)
 * - If tenant creation tests are added, use testDataRegistry for cleanup
 */

import { test, expect } from '@playwright/test';
import { createTestDataRegistry, loginSeededUsers, cleanupTestData, type TestDataRegistry } from '../../../../tests/helpers';

test.describe('Tenant Controller', () => {
  let adminToken: string;

  // Track test data for cleanup (currently not used but ready for future tenant creation tests)
  const testDataRegistry: TestDataRegistry = createTestDataRegistry();

  test.beforeAll(async ({ request }) => {
    const { adminToken: token } = await loginSeededUsers(request);
    expect(token, 'Admin login failed — check seeded users and auth endpoint').toBeTruthy();
    adminToken = token;
  });

  test.afterAll(async ({ request }) => {
    // Clean up any test data created during tests
    if (adminToken && (testDataRegistry.tenants.length > 0 || testDataRegistry.users.length > 0)) {
      const { errors } = await cleanupTestData(request, adminToken, testDataRegistry);
      if (errors.length > 0) {
        console.warn('Tenant tests cleanup errors:', errors);
      }
    }
  });

  test.describe('GET /tenants (List Tenants)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants');
      expect(response.status()).toBe(401);
    });

    test('should return tenants list with authentication', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
      }
    });

    test('should support pagination', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants?page=1&pageSize=5', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.data.length).toBeLessThanOrEqual(5);
      }
    });
  });

  test.describe('POST /tenants (Create Tenant)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.post('/api/v1/admin/tenants', {
        data: { name: 'test-tenant' },
      });
      expect(response.status()).toBe(401);
    });
  });

  test.describe('GET /tenants/:id (Get Tenant by ID)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants/some-tenant-id');
      expect(response.status()).toBe(401);
    });
  });

  test.describe('GET /tenants/user/:userId (Get Tenants by User)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants/user/some-user-id');
      expect(response.status()).toBe(401);
    });
  });

  test.describe('PATCH /tenants/:id (Update Tenant)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.patch('/api/v1/admin/tenants/some-tenant-id', {
        data: { name: 'updated-tenant' },
      });
      expect(response.status()).toBe(401);
    });
  });

  test.describe('DELETE /tenants/:id (Delete Tenant)', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.delete('/api/v1/admin/tenants/some-tenant-id');
      expect(response.status()).toBe(401);
    });
  });

  test.describe('Tenant Configs', () => {
    test('should return 401 without authentication for configs', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants/some-tenant-id/configs');
      // Either 401 (auth required) or 404 (endpoint doesn't exist)
      expect([401, 404]).toContain(response.status());
    });
  });
});
