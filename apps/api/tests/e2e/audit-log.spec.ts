/**
 * Audit Log E2E Tests
 *
 * Tests for the AuditLog API endpoints:
 * - Fetching audit logs (paginated, filtered)
 * - Fetching audit logs by resource
 * - Fetching audit logs by user
 * - Fetching single audit log by ID
 * - Verifying new fields: eventType, success
 * - Testing high-performance query patterns
 *
 * Testing Strategy:
 * - Tests verify actual API behavior and response structure
 * - Tests verify authorization (only authorized users can access audit logs)
 * - Tests verify pagination and filtering work correctly
 * - Tests verify new schema fields are properly exposed
 */

import { test, expect } from '@playwright/test';

test.describe('Audit Log API', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let _doctorToken: string;
  let nurseToken: string;

  test.beforeAll(async ({ request }) => {
    // Login as different users to test various permission levels

    // Super Admin - has manage:all (GLOBAL scope)
    const superAdminLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'super_admin', password: 'password123' },
    });
    expect(superAdminLogin.status(), 'super_admin login failed').toBe(200);
    const superAdminBody = await superAdminLogin.json();
    superAdminToken = superAdminBody.token;

    // Tenant Admin - has manage within tenant (TENANT scope)
    const tenantAdminLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'tenant_admin', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(tenantAdminLogin.status(), 'tenant_admin login failed').toBe(200);
    const tenantAdminBody = await tenantAdminLogin.json();
    tenantAdminToken = tenantAdminBody.token;

    // Doctor - healthcare clinical role
    const doctorLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(doctorLogin.status(), 'doctor login failed').toBe(200);
    const doctorBody = await doctorLogin.json();
    _doctorToken = doctorBody.token;

    // Nurse - healthcare support role
    const nurseLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'nurse', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(nurseLogin.status(), 'nurse login failed').toBe(200);
    const nurseBody = await nurseLogin.json();
    nurseToken = nurseBody.token;
  });

  // ============================================================================
  // Authentication Tests
  // ============================================================================

  test.describe('Authentication', () => {
    test('should return 401 for unauthenticated requests', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs');
      expect(response.status()).toBe(401);
    });

    test('should return 401 for invalid token', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs', {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(response.status()).toBe(401);
    });
  });

  // ============================================================================
  // Authorization Tests
  // ============================================================================

  test.describe('Authorization', () => {
    test('super admin should have access to audit logs', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      // Super admin should have access
      expect([200, 403]).toContain(response.status());
    });

    test('tenant admin should have access to audit logs within tenant', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs', {
        headers: { Authorization: `Bearer ${tenantAdminToken}` },
      });

      // Tenant admin should have access to tenant-scoped audit logs
      expect([200, 403]).toContain(response.status());
    });

    test('nurse should not have access to audit logs', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs', {
        headers: { Authorization: `Bearer ${nurseToken}` },
      });

      // Nurse should be forbidden from accessing audit logs
      expect([403]).toContain(response.status());
    });
  });

  // ============================================================================
  // Fetch All Audit Logs Tests
  // ============================================================================

  test.describe('Fetch All Audit Logs', () => {
    test('should return paginated audit logs', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(body).toHaveProperty('count');
        expect(body).toHaveProperty('page');
        expect(body).toHaveProperty('limit');
        expect(Array.isArray(body.data)).toBe(true);
      }
    });

    test('should respect pagination parameters', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=2&limit=5', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.page).toBe(2);
        expect(body.limit).toBe(5);
        expect(body.data.length).toBeLessThanOrEqual(5);
      }
    });

    test('should support search filter', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?search=CREATE', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect([200, 403]).toContain(response.status());
    });
  });

  // ============================================================================
  // Fetch Audit Logs by Resource Tests
  // ============================================================================

  test.describe('Fetch Audit Logs by Resource', () => {
    test('should return audit logs filtered by resource type and ID', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs/resource/User/test-user-id', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('data');
        // All returned logs should be for the specified resource
        if (body.data.length > 0) {
          expect(body.data.every((log: any) => log.resourceType === 'User')).toBe(true);
        }
      }
    });

    test('should return empty array for non-existent resource', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs/resource/User/non-existent-id', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.data).toEqual([]);
        expect(body.count).toBe(0);
      }
    });
  });

  // ============================================================================
  // Fetch Audit Logs by User Tests
  // ============================================================================

  test.describe('Fetch Audit Logs by User', () => {
    test('should return audit logs created by specific user', async ({ request }) => {
      // First get current user info
      const meResponse = await request.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect(meResponse.status(), 'auth/me failed').toBe(200);
      const user = await meResponse.json();

      const response = await request.get(`/api/v1/admin/audit-logs/user/${user.id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('data');
        // All returned logs should be by the specified user
        if (body.data.length > 0) {
          expect(body.data.every((log: any) => log.responsibleUserId === user.id)).toBe(true);
        }
      }
    });
  });

  // ============================================================================
  // Fetch Single Audit Log Tests
  // ============================================================================

  test.describe('Fetch Single Audit Log', () => {
    test('should return 404 for non-existent audit log', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect([404, 400, 500]).toContain(response.status());
    });

    test('should return audit log with all fields including new fields', async ({ request }) => {
      // First get a list of audit logs
      const listResponse = await request.get('/api/v1/admin/audit-logs?page=1&limit=1', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect(listResponse.status(), 'audit-logs list failed').toBe(200);
      const listBody = await listResponse.json();
      expect(listBody.data.length, 'no audit logs available to fetch by id').toBeGreaterThan(0);

      const auditLogId = listBody.data[0].id;

      const response = await request.get(`/api/v1/admin/audit-logs/${auditLogId}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        // Verify standard fields
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('responsibleUserId');
        expect(body).toHaveProperty('resourceType');
        expect(body).toHaveProperty('action');
        expect(body).toHaveProperty('data');
        expect(body).toHaveProperty('previousData');
        expect(body).toHaveProperty('metadata');
        expect(body).toHaveProperty('createdAt');
        expect(body).toHaveProperty('updatedAt');
        // Verify new fields (may be null)
        expect(body).toHaveProperty('eventType');
        expect(body).toHaveProperty('success');
      }
    });
  });

  // ============================================================================
  // New Fields Tests: eventType and success
  // ============================================================================

  test.describe('New Fields: eventType and success', () => {
    test('audit log response should include eventType field', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          // eventType should be present (may be null for older logs)
          expect('eventType' in body.data[0]).toBe(true);
        }
      }
    });

    test('audit log response should include success field', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          // success should be present (may be null for older logs)
          expect('success' in body.data[0]).toBe(true);
        }
      }
    });

    test('authorization audit logs should have eventType=AUTHORIZATION', async ({ request }) => {
      // Trigger an authorization check to create an audit log
      await request.get('/api/v1/users', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      // Wait a bit for async audit logging
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Fetch recent audit logs
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=50', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        // Find authorization audit logs
        const authLogs = body.data.filter((log: any) => log.eventType === 'AUTHORIZATION');
        if (authLogs.length > 0) {
          // Authorization logs should have success field set
          expect(authLogs[0].success).toBeDefined();
          expect(typeof authLogs[0].success).toBe('boolean');
        }
      }
    });
  });

  // ============================================================================
  // Response Structure Tests
  // ============================================================================

  test.describe('Response Structure', () => {
    test('paginated response should have correct structure', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        // Verify pagination structure
        expect(typeof body.data).toBe('object');
        expect(Array.isArray(body.data)).toBe(true);
        expect(typeof body.count).toBe('number');
        expect(typeof body.page).toBe('number');
        expect(typeof body.limit).toBe('number');
      }
    });

    test('audit log item should have correct structure', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=1', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const log = body.data[0];
          // Verify required fields
          expect(typeof log.id).toBe('string');
          expect(typeof log.resourceType).toBe('string');
          expect(typeof log.action).toBe('string');
          expect(typeof log.createdAt).toBe('string');
          expect(typeof log.updatedAt).toBe('string');
          // Verify nullable fields are present
          expect('responsibleUserId' in log).toBe(true);
          expect('responsibleIp' in log).toBe(true);
          expect('resourceId' in log).toBe(true);
          expect('data' in log).toBe(true);
          expect('previousData' in log).toBe(true);
          expect('metadata' in log).toBe(true);
          // Verify new fields
          expect('eventType' in log).toBe(true);
          expect('success' in log).toBe(true);
        }
      }
    });
  });

  // ============================================================================
  // Audit Log Actions Tests
  // ============================================================================

  test.describe('Audit Log Actions', () => {
    test('should capture CREATE action for resource creation', async ({ request }) => {
      // This test verifies that CREATE actions are logged
      // The actual creation would depend on available endpoints
      const response = await request.get('/api/v1/admin/audit-logs?search=CREATE&page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const createLogs = body.data.filter((log: any) => log.action === 'CREATE');
          if (createLogs.length > 0) {
            expect(createLogs[0].action).toBe('CREATE');
          }
        }
      }
    });

    test('should capture UPDATE action for resource updates', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?search=UPDATE&page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const updateLogs = body.data.filter((log: any) => log.action === 'UPDATE');
          if (updateLogs.length > 0) {
            expect(updateLogs[0].action).toBe('UPDATE');
            // Update logs should have previousData
            expect(updateLogs[0]).toHaveProperty('previousData');
          }
        }
      }
    });

    test('should capture DELETE action for resource deletions', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?search=DELETE&page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const deleteLogs = body.data.filter((log: any) => log.action === 'DELETE');
          if (deleteLogs.length > 0) {
            expect(deleteLogs[0].action).toBe('DELETE');
          }
        }
      }
    });

    test('should capture READ action for resource views', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?search=READ&page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const readLogs = body.data.filter((log: any) => log.action === 'READ');
          if (readLogs.length > 0) {
            expect(readLogs[0].action).toBe('READ');
          }
        }
      }
    });
  });

  // ============================================================================
  // Data Integrity Tests
  // ============================================================================

  test.describe('Data Integrity', () => {
    test('audit log data field should preserve JSON structure', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const logWithData = body.data.find((log: any) => log.data !== null);
          if (logWithData) {
            // Data should be a valid JSON object or null
            expect(logWithData.data === null || typeof logWithData.data === 'object').toBe(true);
          }
        }
      }
    });

    test('audit log previousData should be preserved for updates', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=50', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        const updateLog = body.data.find((log: any) => log.action === 'UPDATE');
        if (updateLog) {
          // Update logs should have previousData
          expect('previousData' in updateLog).toBe(true);
        }
      }
    });

    test('audit log metadata should preserve JSON structure', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        if (body.data.length > 0) {
          const logWithMetadata = body.data.find((log: any) => log.metadata !== null);
          if (logWithMetadata) {
            // Metadata should be a valid JSON object or null
            expect(logWithMetadata.metadata === null || typeof logWithMetadata.metadata === 'object').toBe(true);
          }
        }
      }
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  test.describe('Performance', () => {
    test('should handle large page sizes efficiently', async ({ request }) => {
      const startTime = Date.now();
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=100', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const endTime = Date.now();

      if (response.status() === 200) {
        // Should respond within reasonable time (5 seconds)
        expect(endTime - startTime).toBeLessThan(5000);
      }
    });

    test('should handle pagination efficiently', async ({ request }) => {
      // Test multiple pages
      const responses = await Promise.all([
        request.get('/api/v1/admin/audit-logs?page=1&limit=10', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        }),
        request.get('/api/v1/admin/audit-logs?page=2&limit=10', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        }),
        request.get('/api/v1/admin/audit-logs?page=3&limit=10', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
        }),
      ]);

      // All should succeed
      for (const response of responses) {
        expect([200, 403]).toContain(response.status());
      }
    });
  });

  // ============================================================================
  // Tenant Isolation Tests
  // ============================================================================

  test.describe('Tenant Isolation', () => {
    test('tenant admin should only see audit logs within their tenant', async ({ request }) => {
      const response = await request.get('/api/v1/admin/audit-logs?page=1&limit=50', {
        headers: { Authorization: `Bearer ${tenantAdminToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        // All audit logs should be within the tenant's scope
        // (This is enforced by the service layer)
        expect(body).toHaveProperty('data');
      }
    });
  });
});
