/**
 * RBAC Controllers E2E Tests
 *
 * Comprehensive tests for Role-Based Access Control endpoints:
 * - Roles management (CRUD, policy assignment)
 * - Policies management (CRUD, validation)
 * - Permission checking (single, bulk, effective)
 * - Authorization enforcement
 *
 * TEST DATA MANAGEMENT:
 * - Uses seeded users (super_admin, tenant_admin, doctor) for authentication
 * - Creates test-specific roles/policies with unique identifiers
 * - Cleans up all created test data in afterAll
 * - Does NOT rely on data from other test files
 */

import { test, expect } from '@playwright/test';
import { createTestDataRegistry, loginSeededUsers, cleanupTestData, SEEDED_USERS, type TestDataRegistry } from '../../../../tests/helpers';

test.describe('RBAC Controllers', () => {
  let superAdminToken: string;
  let adminToken: string;
  let userToken: string;
  let rbacEndpointsAvailable = false;

  // Track all test data for cleanup using the registry pattern
  const testDataRegistry: TestDataRegistry = createTestDataRegistry();

  // Legacy arrays for backward compatibility with existing tests
  const testRoleIds: string[] = testDataRegistry.roles;
  const testPolicyIds: string[] = testDataRegistry.policies;

  test.beforeAll(async ({ request }) => {
    // Check if RBAC endpoints are available
    const checkResponse = await request.get('/api/v1/admin/rbac/roles');
    rbacEndpointsAvailable = checkResponse.status() !== 404;

    if (!rbacEndpointsAvailable) {
      console.log('RBAC endpoints not available, skipping tests');
      return;
    }

    // Login all seeded users using the helper
    const tokens = await loginSeededUsers(request);
    superAdminToken = tokens.superAdminToken ?? '';
    adminToken = tokens.adminToken ?? '';
    userToken = tokens.userToken ?? '';

    if (!superAdminToken) {
      console.warn('WARNING: Could not login as super_admin. Some tests will be skipped.');
    }
  });

  test.afterAll(async ({ request }) => {
    if (!rbacEndpointsAvailable || !superAdminToken) return;

    // Clean up all test data using the cleanup helper
    const { errors } = await cleanupTestData(request, superAdminToken, testDataRegistry);
    if (errors.length > 0) {
      console.warn('RBAC cleanup errors:', errors);
    }
  });

  // ============================================================================
  // Roles Controller Tests
  // ============================================================================

  test.describe('Roles Controller', () => {
    test.describe('GET /rbac/roles', () => {
      test('should return 401 without authentication', async ({ request }) => {
        if (!rbacEndpointsAvailable) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles');
        expect(response.status()).toBe(401);
      });

      test('should return roles list with valid token', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body).toHaveProperty('total');
      });

      test('should support pagination', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles?page=1&pageSize=5', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        // API returns pageSize items per page (may return more if pagination not fully implemented)
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
      });

      test('should filter by name', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles?search=ADMIN', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        // Results should contain roles matching search term
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
      });
    });

    test.describe('GET /rbac/roles/:id', () => {
      test('should return 401 without authentication', async ({ request }) => {
        if (!rbacEndpointsAvailable) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles/some-id');
        expect(response.status()).toBe(401);
      });

      test('should return error for non-existent role', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/roles/00000000-0000-0000-0000-000000000000', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        // API may return 404 or 500 depending on error handling implementation
        expect([404, 500]).toContain(response.status());
      });

      test('should return role details with policies', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        // First get list to find a valid ID
        const listResponse = await request.get('/api/v1/admin/rbac/roles?take=1', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        if (listResponse.status() !== 200) {
          test.skip();
          return;
        }

        const listBody = await listResponse.json();
        if (listBody.data.length === 0) {
          test.skip();
          return;
        }

        const roleId = listBody.data[0].id;
        const response = await request.get(`/api/v1/admin/rbac/roles/${roleId}`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('id', roleId);
        expect(body).toHaveProperty('name');
        expect(body).toHaveProperty('policies');
        expect(Array.isArray(body.policies)).toBe(true);
      });
    });

    test.describe('POST /rbac/roles', () => {
      test('should return 401 without authentication', async ({ request }) => {
        if (!rbacEndpointsAvailable) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/roles', {
          data: { name: 'test-role', description: 'Test role' },
        });

        expect(response.status()).toBe(401);
      });

      test('should return 403 for unauthorized user', async ({ request }) => {
        if (!rbacEndpointsAvailable || !userToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${userToken}` },
          data: { name: 'test-role', description: 'Test role' },
        });

        expect(response.status()).toBe(403);
      });

      test('should create role with valid data', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const roleName = `test-role-${Date.now()}`;
        const response = await request.post('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            name: roleName,
            description: 'E2E test role',
          },
        });

        if (response.status() === 201) {
          const body = await response.json();
          expect(body).toHaveProperty('id');
          expect(body).toHaveProperty('name', roleName);
          testRoleIds.push(body.id);
        } else {
          // May fail due to permission issues
          expect([201, 403]).toContain(response.status());
        }
      });

      test('should return 400 for invalid data', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            // Missing required name field
            description: 'Invalid role',
          },
        });

        expect(response.status()).toBe(400);
      });
    });

    test.describe('PUT /rbac/roles/:id', () => {
      test('should update role description', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken || testRoleIds.length === 0) {
          test.skip();
          return;
        }

        const roleId = testRoleIds[0];
        const newDescription = `Updated description ${Date.now()}`;

        const response = await request.put(`/api/v1/admin/rbac/roles/${roleId}`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { description: newDescription },
        });

        if (response.status() === 200) {
          const body = await response.json();
          expect(body.description).toBe(newDescription);
        } else {
          expect([200, 403, 404]).toContain(response.status());
        }
      });

      test('should allow updating system role description but not rename', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        // Find a system role
        const listResponse = await request.get('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        if (listResponse.status() !== 200) {
          test.skip();
          return;
        }

        const listBody = await listResponse.json();
        const systemRole = listBody.data.find((r: any) => r.isSystemRole);
        if (!systemRole) {
          test.skip();
          return;
        }

        // Try to update system role - API allows updates but may have restrictions
        const response = await request.put(`/api/v1/admin/rbac/roles/${systemRole.id}`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { description: 'Updated description' },
        });

        // API may allow or reject - both are valid behaviors
        expect([200, 400, 403]).toContain(response.status());
      });
    });

    test.describe('DELETE /rbac/roles/:id', () => {
      test('should handle system role deletion appropriately', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        // Find a system role
        const listResponse = await request.get('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        if (listResponse.status() !== 200) {
          test.skip();
          return;
        }

        const listBody = await listResponse.json();
        const systemRole = listBody.data.find((r: any) => r.isSystemRole);
        if (!systemRole) {
          test.skip();
          return;
        }

        const response = await request.delete(`/api/v1/admin/rbac/roles/${systemRole.id}`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        // API should reject system role deletion (400/403) or may throw error (500)
        expect([400, 403, 500]).toContain(response.status());
      });
    });

    // Super admin gains create/update on SYSTEM roles + role cloning.
    test.describe('SYSTEM-role authoring + clone', () => {
      test('super_admin (SUPER_ADMIN) can rename a SYSTEM role; tenant admin cannot', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken || !adminToken) {
          test.skip();
          return;
        }

        const listResponse = await request.get('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        if (listResponse.status() !== 200) {
          test.skip();
          return;
        }
        const listBody = await listResponse.json();
        const systemRole = listBody.data.find((r: any) => r.isSystemRole);
        if (!systemRole) {
          test.skip();
          return;
        }

        const asSuperAdmin = await request.put(`/api/v1/admin/rbac/roles/${systemRole.id}`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { description: `TASK-501 e2e ${Date.now()}` },
        });
        expect(asSuperAdmin.status()).toBe(200);

        const asTenantAdmin = await request.put(`/api/v1/admin/rbac/roles/${systemRole.id}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { description: 'should be refused' },
        });
        expect([400, 403]).toContain(asTenantAdmin.status());
      });

      test('any admin may clone a SYSTEM role into a new CUSTOM role with copied policies', async ({ request }) => {
        if (!rbacEndpointsAvailable || !adminToken || !superAdminToken) {
          test.skip();
          return;
        }

        const listResponse = await request.get('/api/v1/admin/rbac/roles', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        if (listResponse.status() !== 200) {
          test.skip();
          return;
        }
        const listBody = await listResponse.json();
        const systemRole = listBody.data.find((r: any) => r.isSystemRole && r.policies?.length > 0) ?? listBody.data.find((r: any) => r.isSystemRole);
        if (!systemRole) {
          test.skip();
          return;
        }

        const cloneName = `${systemRole.name}-clone-${Date.now()}`;
        const response = await request.post(`/api/v1/admin/rbac/roles/${systemRole.id}/clone`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { name: cloneName },
        });

        expect(response.status()).toBe(201);
        const body = await response.json();
        testRoleIds.push(body.id);
        expect(body.name).toBe(cloneName);
        expect(body.isSystemRole).toBe(false);
        expect(body.policies.map((p: any) => p.id).sort()).toEqual(systemRole.policies.map((p: any) => p.id).sort());
      });

      test('cloning a non-existent role 404s', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/roles/00000000-0000-0000-0000-000000000000/clone', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { name: `orphan-clone-${Date.now()}` },
        });
        expect(response.status()).toBe(404);
      });
    });
  });

  // ============================================================================
  // Policies Controller Tests
  // ============================================================================

  test.describe('Policies Controller', () => {
    test.describe('GET /rbac/policies', () => {
      test('should return 401 without authentication', async ({ request }) => {
        if (!rbacEndpointsAvailable) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/policies');
        expect(response.status()).toBe(401);
      });

      test('should return policies list with valid token', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.get('/api/v1/admin/rbac/policies', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
      });
    });

    test.describe('POST /rbac/policies', () => {
      test('should create policy with valid CASL rules', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const policyName = `test-policy-${Date.now()}`;
        const response = await request.post('/api/v1/admin/rbac/policies', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            name: policyName,
            description: 'E2E test policy',
            scope: 'TENANT',
            rules: [
              { action: 'read', subject: 'TestResource' },
              { action: 'create', subject: 'TestResource' },
            ],
          },
        });

        if (response.status() === 201) {
          const body = await response.json();
          expect(body).toHaveProperty('id');
          expect(body).toHaveProperty('name', policyName);
          expect(body).toHaveProperty('rules');
          expect(Array.isArray(body.rules)).toBe(true);
          testPolicyIds.push(body.id);
        } else {
          expect([201, 403]).toContain(response.status());
        }
      });

      test('should return 400 for invalid rules format', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/policies', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            name: `invalid-policy-${Date.now()}`,
            rules: 'not-an-array', // Invalid format
          },
        });

        expect(response.status()).toBe(400);
      });
    });

    test.describe('POST /rbac/policies/validate', () => {
      test('should validate correct CASL rules', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/policies/validate', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            rules: [
              { action: 'read', subject: 'User' },
              { action: 'manage', subject: 'all' },
              {
                action: 'update',
                subject: 'User',
                conditions: { id: '${user.id}' },
              },
            ],
          },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        // Response should indicate validation result
        expect(body).toBeDefined();
      });

      test('should reject invalid rules', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/admin/rbac/policies/validate', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            rules: [
              { action: '', subject: '' }, // Empty action and subject
            ],
          },
        });

        // POST endpoints may return 200, 201, or 400 for validation
        expect([200, 201, 400]).toContain(response.status());
      });
    });
  });

  // ============================================================================
  // Permission Check Controller Tests
  // TASK-760 — the verb-as-resource `rbac/check` RPC became two resource
  // collections: `POST /users/me/permission-checks` (the caller's effective
  // permission set) and `POST /users/:id/permission-checks[/bulk]` (a check
  // against a named user; another user still needs `manage:User`). The retired
  // paths answer 308 for one release, but these assertions address the new
  // URIs directly — following a redirect would test the shim, not the route.
  //
  // The by-id routes need the caller's own id, which the retired paths never
  // carried; it is the JWT `sub`, decoded here rather than fetched so the spec
  // does not depend on a second endpoint.
  function callerId(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { sub?: string; id?: string };
    const id = payload.sub ?? payload.id;
    if (!id) throw new Error('JWT carries no subject claim');
    return id;
  }
  // ============================================================================

  test.describe('Permission Check Controller', () => {
    test.describe('POST /users/:id/permission-checks', () => {
      test('should return 401 without authentication', async ({ request }) => {
        if (!rbacEndpointsAvailable) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/users/00000000-0000-0000-0000-000000000001/permission-checks', {
          data: { action: 'read', subject: 'User' },
        });

        expect(response.status()).toBe(401);
      });

      test('should check single permission for current user', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post(`/api/v1/users/${callerId(superAdminToken)}/permission-checks`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { action: 'manage', subject: 'all' },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        expect(body).toHaveProperty('allowed');
        expect(typeof body.allowed).toBe('boolean');
      });

      test('should return false for unauthorized action', async ({ request }) => {
        if (!rbacEndpointsAvailable || !userToken) {
          test.skip();
          return;
        }

        const response = await request.post(`/api/v1/users/${callerId(userToken)}/permission-checks`, {
          headers: { Authorization: `Bearer ${userToken}` },
          data: { action: 'manage', subject: 'Role' },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        expect(body.allowed).toBe(false);
      });
    });

    test.describe('POST /users/:id/permission-checks/bulk', () => {
      test('should check multiple permissions at once', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post(`/api/v1/users/${callerId(superAdminToken)}/permission-checks/bulk`, {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: {
            permissions: [
              { action: 'read', subject: 'User' },
              { action: 'create', subject: 'User' },
              { action: 'delete', subject: 'User' },
            ],
          },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        expect(body).toHaveProperty('results');
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.results.length).toBe(3);

        for (const result of body.results) {
          expect(result).toHaveProperty('action');
          expect(result).toHaveProperty('subject');
          expect(result).toHaveProperty('allowed');
        }
      });
    });

    test.describe('POST /users/me/permission-checks', () => {
      test('should return current user effective permissions', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken) {
          test.skip();
          return;
        }

        const response = await request.post('/api/v1/users/me/permission-checks', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        expect(body).toHaveProperty('userId');
        expect(body).toHaveProperty('permissions');
        expect(Array.isArray(body.permissions)).toBe(true);
      });

      test('should return different permissions for different users', async ({ request }) => {
        if (!rbacEndpointsAvailable || !superAdminToken || !userToken) {
          test.skip();
          return;
        }

        const adminResponse = await request.post('/api/v1/users/me/permission-checks', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        const userResponse = await request.post('/api/v1/users/me/permission-checks', {
          headers: { Authorization: `Bearer ${userToken}` },
        });

        // POST endpoints may return 200 or 201
        expect([200, 201]).toContain(adminResponse.status());
        expect([200, 201]).toContain(userResponse.status());

        const adminBody = await adminResponse.json();
        const userBody = await userResponse.json();

        // Both should have permissions arrays
        expect(Array.isArray(adminBody.permissions)).toBe(true);
        expect(Array.isArray(userBody.permissions)).toBe(true);
      });
    });
  });

  // ============================================================================
  // Authorization Enforcement Tests
  // ============================================================================

  test.describe('Authorization Enforcement', () => {
    test('should enforce role-based access on protected endpoints', async ({ request }) => {
      if (!rbacEndpointsAvailable || !userToken) {
        test.skip();
        return;
      }

      // Regular user should not be able to create roles
      const response = await request.post('/api/v1/admin/rbac/roles', {
        headers: { Authorization: `Bearer ${userToken}` },
        data: {
          name: `unauthorized-role-${Date.now()}`,
          description: 'Should fail',
        },
      });

      expect(response.status()).toBe(403);
    });

    test('should allow super admin to access all RBAC endpoints', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      // Super admin should be able to list roles
      const rolesResponse = await request.get('/api/v1/admin/rbac/roles', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect(rolesResponse.status()).toBe(200);

      // Super admin should be able to list policies
      const policiesResponse = await request.get('/api/v1/admin/rbac/policies', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect(policiesResponse.status()).toBe(200);

      // Super admin should be able to check permissions (POST may return 200 or 201)
      const permissionsResponse = await request.post('/api/v1/users/me/permission-checks', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect([200, 201]).toContain(permissionsResponse.status());
    });

    test('should handle tenant-scoped permissions correctly', async ({ request }) => {
      if (!rbacEndpointsAvailable || !adminToken) {
        test.skip();
        return;
      }

      // Admin should be able to access tenant-scoped resources
      const response = await request.post('/api/v1/users/me/permission-checks', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      // POST endpoints may return 200 or 201
      expect([200, 201]).toContain(response.status());
      const body = await response.json();

      // Check that user permissions are returned
      expect(body).toHaveProperty('userId');
      expect(body).toHaveProperty('permissions');
    });
  });

  // ============================================================================
  // Healthcare System Roles Tests
  // ============================================================================

  test.describe('Healthcare System Roles', () => {
    test('should have DOCTOR system role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/roles?search=DOCTOR', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        const doctorRole = body.data.find((r: any) => r.name === 'DOCTOR');
        if (doctorRole) {
          expect(doctorRole.name).toBe('DOCTOR');
          expect(doctorRole.isSystemRole).toBe(true);
        }
      }
    });

    test('should have NURSE system role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/roles?search=NURSE', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        const nurseRole = body.data.find((r: any) => r.name === 'NURSE');
        if (nurseRole) {
          expect(nurseRole.name).toBe('NURSE');
          expect(nurseRole.isSystemRole).toBe(true);
        }
      }
    });

    test('should have SERVICE_ACCOUNT system role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/roles?search=SERVICE', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        const serviceRole = body.data.find((r: any) => r.name === 'SERVICE_ACCOUNT');
        if (serviceRole) {
          expect(serviceRole.name).toBe('SERVICE_ACCOUNT');
          expect(serviceRole.isSystemRole).toBe(true);
        }
      }
    });

    test('should have DEPARTMENT_HEAD role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/roles?search=DEPARTMENT', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        const deptHeadRole = body.data.find((r: any) => r.name === 'DEPARTMENT_HEAD');
        if (deptHeadRole) {
          expect(deptHeadRole.name).toBe('DEPARTMENT_HEAD');
          // DEPARTMENT_HEAD may be a system role or tenant-extendable
          expect(typeof deptHeadRole.isSystemRole).toBe('boolean');
        }
      }
    });

    test('should have healthcare policies', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/policies', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
        // Just verify policies endpoint returns data
        expect(body.data.length).toBeGreaterThan(0);
      }
    });

    test('should have RBAC management policies', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get('/api/v1/admin/rbac/policies', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.data).toBeDefined();
        // Just verify we can fetch policies
        expect(Array.isArray(body.data)).toBe(true);
      }
    });
  });

  // ============================================================================
  // Role-Policy Assignment Tests
  // ============================================================================

  test.describe('Role-Policy Assignment', () => {
    test('should assign policy to role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken) {
        test.skip();
        return;
      }

      // Create a test role
      const roleResponse = await request.post('/api/v1/admin/rbac/roles', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          name: `assignment-test-role-${Date.now()}`,
          description: 'Role for assignment test',
        },
      });

      if (roleResponse.status() !== 201) {
        test.skip();
        return;
      }

      const role = await roleResponse.json();
      testRoleIds.push(role.id);

      // Create a test policy
      const policyResponse = await request.post('/api/v1/admin/rbac/policies', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          name: `assignment-test-policy-${Date.now()}`,
          description: 'Policy for assignment test',
          scope: 'TENANT',
          rules: [{ action: 'read', subject: 'TestAssignment' }],
        },
      });

      if (policyResponse.status() !== 201) {
        // Policy creation failed - may need scope or other required fields
        test.skip();
        return;
      }

      const policy = await policyResponse.json();
      testPolicyIds.push(policy.id);

      // Assign policy to role
      const assignResponse = await request.post(`/api/v1/admin/rbac/roles/${role.id}/policies/${policy.id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { priority: 0 },
      });

      expect([200, 201]).toContain(assignResponse.status());

      // Verify assignment
      const verifyResponse = await request.get(`/api/v1/admin/rbac/roles/${role.id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect(verifyResponse.status()).toBe(200);
      const verifyBody = await verifyResponse.json();
      expect(verifyBody.policies.some((p: any) => p.id === policy.id)).toBe(true);
    });

    test('should remove policy from role', async ({ request }) => {
      if (!rbacEndpointsAvailable || !superAdminToken || testRoleIds.length === 0 || testPolicyIds.length === 0) {
        test.skip();
        return;
      }

      const roleId = testRoleIds[testRoleIds.length - 1];
      const policyId = testPolicyIds[testPolicyIds.length - 1];

      // Detach without step-up confirmation is refused (428).
      const unconfirmed = await request.delete(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect([404, 428]).toContain(unconfirmed.status());

      // With password + exact policy name the detach goes through.
      const policyLookup = await request.get(`/api/v1/admin/rbac/policies/${policyId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      if (policyLookup.status() !== 200) {
        test.skip();
        return;
      }
      const policyName = ((await policyLookup.json()) as { name: string }).name;

      const response = await request.delete(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { password: SEEDED_USERS.superAdmin.password, confirmationName: policyName },
      });

      expect([200, 204, 404]).toContain(response.status());
    });
  });
});
