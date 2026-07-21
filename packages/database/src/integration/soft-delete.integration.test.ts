/**
 * Soft-Delete Integration Tests
 *
 * End-to-end tests that verify soft-delete functionality against a real PostgreSQL database.
 * These tests use the test infrastructure (docker-compose.test.yml) and do NOT mock Prisma.
 *
 * Prerequisites:
 *   1. Start test infrastructure: pnpm docker:test:up
 *   2. Push schema: pnpm test:db:push
 *   3. Run tests: pnpm test:integration
 *
 * Test Coverage:
 *   - Soft-delete filter is applied to findMany, findFirst, count, aggregate, groupBy
 *   - findUnique does NOT filter (documented limitation)
 *   - Filter bypass when resourceStatus is explicitly set
 *   - softDelete and restore operations work correctly
 *   - Multi-tenant soft-delete isolation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture, tenant context not yet established
import {
  getPlatformAdminPrismaClient_Unscoped,
  getExtendedPrismaClient,
  CorePrismaClient,
  ExtendedCorePrismaClient,
} from '../client';

// Test data constants
const TEST_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

describe('Soft-Delete Integration Tests', () => {
  let basePrisma: CorePrismaClient;
  let extendedPrisma: ExtendedCorePrismaClient;

  beforeAll(async () => {
    // Get both client types
    basePrisma = getPlatformAdminPrismaClient_Unscoped();
    extendedPrisma = getExtendedPrismaClient();

    // Verify database connection
    await basePrisma.$connect();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    // Using base client to ensure we can delete soft-deleted records too
    await basePrisma.$executeRaw`
      DELETE FROM core."Department" WHERE "tenantId" = ${TEST_TENANT_ID}
    `;
  });

  describe('Department Model - Soft-Delete Filtering', () => {
    /**
     * Helper to create test departments
     */
    async function createTestDepartment(
      code: string,
      name: string,
      resourceStatus: 'ENABLED' | 'DISABLED' | 'ARCHIVED' | 'DELETED' = 'ENABLED'
    ) {
      return basePrisma.department.create({
        data: {
          tenantId: TEST_TENANT_ID,
          code,
          name,
          description: `Test department: ${name}`,
          resourceStatus,
          createdBy: SYSTEM_USER_ID,
        },
      });
    }

    describe('findMany with soft-delete filter', () => {
      it('should exclude DELETED records by default', async () => {
        // Create test data with different statuses
        await createTestDepartment('DEPT-ENABLED', 'Enabled Department', 'ENABLED');
        await createTestDepartment('DEPT-DISABLED', 'Disabled Department', 'DISABLED');
        await createTestDepartment('DEPT-ARCHIVED', 'Archived Department', 'ARCHIVED');
        await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        // Query with extended client (has soft-delete filter)
        const results = await extendedPrisma.department.findMany({
          where: { tenantId: TEST_TENANT_ID },
        });

        // Should return 3 records (ENABLED, DISABLED, ARCHIVED) but NOT DELETED
        expect(results.length).toBe(3);
        expect(results.map((r) => r.code)).toContain('DEPT-ENABLED');
        expect(results.map((r) => r.code)).toContain('DEPT-DISABLED');
        expect(results.map((r) => r.code)).toContain('DEPT-ARCHIVED');
        expect(results.map((r) => r.code)).not.toContain('DEPT-DELETED');
      });

      it('should include DELETED records when using base client', async () => {
        await createTestDepartment('DEPT-ENABLED', 'Enabled Department', 'ENABLED');
        await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        // Query with base client (NO soft-delete filter)
        const results = await basePrisma.department.findMany({
          where: { tenantId: TEST_TENANT_ID },
        });

        // Should return ALL records including DELETED
        expect(results.length).toBe(2);
        expect(results.map((r) => r.code)).toContain('DEPT-ENABLED');
        expect(results.map((r) => r.code)).toContain('DEPT-DELETED');
      });

      it('should allow querying only DELETED records when explicitly specified', async () => {
        await createTestDepartment('DEPT-ENABLED', 'Enabled Department', 'ENABLED');
        await createTestDepartment('DEPT-DELETED-1', 'Deleted Department 1', 'DELETED');
        await createTestDepartment('DEPT-DELETED-2', 'Deleted Department 2', 'DELETED');

        // Query with explicit resourceStatus filter
        const results = await extendedPrisma.department.findMany({
          where: {
            tenantId: TEST_TENANT_ID,
            resourceStatus: 'DELETED',
          },
        });

        // Should return only DELETED records
        expect(results.length).toBe(2);
        expect(results.every((r) => r.resourceStatus === 'DELETED')).toBe(true);
      });

      it('should allow querying multiple statuses with "in" condition', async () => {
        await createTestDepartment('DEPT-ENABLED', 'Enabled Department', 'ENABLED');
        await createTestDepartment('DEPT-DISABLED', 'Disabled Department', 'DISABLED');
        await createTestDepartment('DEPT-ARCHIVED', 'Archived Department', 'ARCHIVED');
        await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        // Query with specific statuses including DELETED
        const results = await extendedPrisma.department.findMany({
          where: {
            tenantId: TEST_TENANT_ID,
            resourceStatus: { in: ['ENABLED', 'DELETED'] },
          },
        });

        expect(results.length).toBe(2);
        expect(results.map((r) => r.code)).toContain('DEPT-ENABLED');
        expect(results.map((r) => r.code)).toContain('DEPT-DELETED');
      });
    });

    describe('findFirst with soft-delete filter', () => {
      it('should exclude DELETED records by default', async () => {
        await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');
        await createTestDepartment('DEPT-ENABLED', 'Enabled Department', 'ENABLED');

        const result = await extendedPrisma.department.findFirst({
          where: { tenantId: TEST_TENANT_ID },
          orderBy: { code: 'asc' },
        });

        // Should find ENABLED, not DELETED (even though DELETED comes first alphabetically)
        expect(result).not.toBeNull();
        expect(result?.code).toBe('DEPT-ENABLED');
      });

      it('should return null when only DELETED records exist', async () => {
        await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        const result = await extendedPrisma.department.findFirst({
          where: { tenantId: TEST_TENANT_ID },
        });

        expect(result).toBeNull();
      });
    });

    describe('findUnique behavior (soft-delete aware as of TASK-305 B.12)', () => {
      it('should NOT return DELETED records (findUnique now applies soft-delete filter)', async () => {
        const deleted = await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        const result = await extendedPrisma.department.findUnique({
          where: { id: deleted.id },
        });

        expect(result).toBeNull();
      });

      it('should return DELETED records when caller opts in via explicit resourceStatus', async () => {
        const deleted = await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        const result = await extendedPrisma.department.findUnique({
          where: { id: deleted.id, resourceStatus: 'DELETED' },
        });

        expect(result).not.toBeNull();
        expect(result?.resourceStatus).toBe('DELETED');
      });

      it('findFirst with unique field continues to apply soft-delete filter (parity)', async () => {
        const deleted = await createTestDepartment('DEPT-DELETED', 'Deleted Department', 'DELETED');

        const result = await extendedPrisma.department.findFirst({
          where: { id: deleted.id },
        });

        expect(result).toBeNull();
      });
    });

    describe('count with soft-delete filter', () => {
      it('should exclude DELETED records from count', async () => {
        await createTestDepartment('DEPT-1', 'Department 1', 'ENABLED');
        await createTestDepartment('DEPT-2', 'Department 2', 'ENABLED');
        await createTestDepartment('DEPT-3', 'Department 3', 'DELETED');
        await createTestDepartment('DEPT-4', 'Department 4', 'DELETED');

        const count = await extendedPrisma.department.count({
          where: { tenantId: TEST_TENANT_ID },
        });

        // Should count only non-DELETED records
        expect(count).toBe(2);
      });

      it('should count all records with base client', async () => {
        await createTestDepartment('DEPT-1', 'Department 1', 'ENABLED');
        await createTestDepartment('DEPT-2', 'Department 2', 'DELETED');

        const count = await basePrisma.department.count({
          where: { tenantId: TEST_TENANT_ID },
        });

        expect(count).toBe(2);
      });
    });

    describe('aggregate with soft-delete filter', () => {
      it('should exclude DELETED records from aggregate', async () => {
        await createTestDepartment('DEPT-1', 'Department 1', 'ENABLED');
        await createTestDepartment('DEPT-2', 'Department 2', 'ENABLED');
        await createTestDepartment('DEPT-3', 'Department 3', 'DELETED');

        const result = await extendedPrisma.department.aggregate({
          where: { tenantId: TEST_TENANT_ID },
          _count: true,
        });

        expect(result._count).toBe(2);
      });
    });

    describe('groupBy with soft-delete filter', () => {
      it('should exclude DELETED records from groupBy', async () => {
        await createTestDepartment('DEPT-1', 'Department 1', 'ENABLED');
        await createTestDepartment('DEPT-2', 'Department 2', 'ENABLED');
        await createTestDepartment('DEPT-3', 'Department 3', 'DISABLED');
        await createTestDepartment('DEPT-4', 'Department 4', 'DELETED');

        const result = await extendedPrisma.department.groupBy({
          by: ['resourceStatus'],
          where: { tenantId: TEST_TENANT_ID },
          _count: true,
        });

        // Should group by ENABLED and DISABLED only (not DELETED)
        expect(result.length).toBe(2);
        expect(result.map((r) => r.resourceStatus)).toContain('ENABLED');
        expect(result.map((r) => r.resourceStatus)).toContain('DISABLED');
        expect(result.map((r) => r.resourceStatus)).not.toContain('DELETED');
      });
    });
  });

  describe('Soft-Delete and Restore Operations', () => {
    async function createTestDepartment(code: string, name: string) {
      return basePrisma.department.create({
        data: {
          tenantId: TEST_TENANT_ID,
          code,
          name,
          resourceStatus: 'ENABLED',
          createdBy: SYSTEM_USER_ID,
        },
      });
    }

    it('should soft-delete a record by updating resourceStatus', async () => {
      const dept = await createTestDepartment('DEPT-TO-DELETE', 'Department to Delete');

      // Soft delete
      const deleted = await basePrisma.department.update({
        where: { id: dept.id },
        data: {
          resourceStatus: 'DELETED',
          resourceStatusUpdatedAt: new Date(),
          resourceStatusUpdatedBy: SYSTEM_USER_ID,
        },
      });

      expect(deleted.resourceStatus).toBe('DELETED');
      expect(deleted.resourceStatusUpdatedAt).not.toBeNull();
      expect(deleted.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);

      // Verify it's filtered from extended client queries
      const found = await extendedPrisma.department.findFirst({
        where: { id: dept.id },
      });
      expect(found).toBeNull();

      // But still accessible via base client
      const foundBase = await basePrisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(foundBase).not.toBeNull();
      expect(foundBase?.resourceStatus).toBe('DELETED');
    });

    it('should restore a soft-deleted record', async () => {
      const dept = await createTestDepartment('DEPT-TO-RESTORE', 'Department to Restore');

      // Soft delete
      await basePrisma.department.update({
        where: { id: dept.id },
        data: { resourceStatus: 'DELETED' },
      });

      // Verify it's hidden
      const hidden = await extendedPrisma.department.findFirst({
        where: { id: dept.id },
      });
      expect(hidden).toBeNull();

      // Restore
      const restored = await basePrisma.department.update({
        where: { id: dept.id },
        data: {
          resourceStatus: 'ENABLED',
          resourceStatusUpdatedAt: new Date(),
          resourceStatusUpdatedBy: SYSTEM_USER_ID,
        },
      });

      expect(restored.resourceStatus).toBe('ENABLED');

      // Verify it's now visible
      const visible = await extendedPrisma.department.findFirst({
        where: { id: dept.id },
      });
      expect(visible).not.toBeNull();
      expect(visible?.code).toBe('DEPT-TO-RESTORE');
    });

    it('should track resourceStatusUpdatedAt timestamp', async () => {
      const dept = await createTestDepartment('DEPT-TIMESTAMP', 'Department for Timestamp Test');

      const beforeDelete = new Date();

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await basePrisma.department.update({
        where: { id: dept.id },
        data: {
          resourceStatus: 'DELETED',
          resourceStatusUpdatedAt: new Date(),
        },
      });

      const afterDelete = new Date();

      const deleted = await basePrisma.department.findUnique({
        where: { id: dept.id },
      });

      expect(deleted?.resourceStatusUpdatedAt).not.toBeNull();
      expect(deleted?.resourceStatusUpdatedAt?.getTime()).toBeGreaterThanOrEqual(beforeDelete.getTime());
      expect(deleted?.resourceStatusUpdatedAt?.getTime()).toBeLessThanOrEqual(afterDelete.getTime());
    });
  });

  describe('Multi-Tenant Soft-Delete Isolation', () => {
    const TENANT_A = '10000000-0000-0000-0000-000000000001';
    const TENANT_B = '10000000-0000-0000-0000-000000000002';

    beforeEach(async () => {
      // Clean up multi-tenant test data
      await basePrisma.$executeRaw`
        DELETE FROM core."Department" WHERE "tenantId" IN (${TENANT_A}, ${TENANT_B})
      `;
    });

    it('should apply soft-delete filter within tenant boundaries', async () => {
      // Create departments for Tenant A
      await basePrisma.department.create({
        data: {
          tenantId: TENANT_A,
          code: 'A-ENABLED',
          name: 'Tenant A Enabled',
          resourceStatus: 'ENABLED',
          createdBy: SYSTEM_USER_ID,
        },
      });
      await basePrisma.department.create({
        data: {
          tenantId: TENANT_A,
          code: 'A-DELETED',
          name: 'Tenant A Deleted',
          resourceStatus: 'DELETED',
          createdBy: SYSTEM_USER_ID,
        },
      });

      // Create departments for Tenant B
      await basePrisma.department.create({
        data: {
          tenantId: TENANT_B,
          code: 'B-ENABLED',
          name: 'Tenant B Enabled',
          resourceStatus: 'ENABLED',
          createdBy: SYSTEM_USER_ID,
        },
      });
      await basePrisma.department.create({
        data: {
          tenantId: TENANT_B,
          code: 'B-DELETED',
          name: 'Tenant B Deleted',
          resourceStatus: 'DELETED',
          createdBy: SYSTEM_USER_ID,
        },
      });

      // Query Tenant A - should only see non-deleted
      const tenantAResults = await extendedPrisma.department.findMany({
        where: { tenantId: TENANT_A },
      });
      expect(tenantAResults.length).toBe(1);
      expect(tenantAResults[0].code).toBe('A-ENABLED');

      // Query Tenant B - should only see non-deleted
      const tenantBResults = await extendedPrisma.department.findMany({
        where: { tenantId: TENANT_B },
      });
      expect(tenantBResults.length).toBe(1);
      expect(tenantBResults[0].code).toBe('B-ENABLED');

      // Query all (no tenant filter) - should see all non-deleted
      const allResults = await extendedPrisma.department.findMany({
        where: {
          tenantId: { in: [TENANT_A, TENANT_B] },
        },
      });
      expect(allResults.length).toBe(2);
    });
  });

  describe('Complex Query Scenarios', () => {
    beforeEach(async () => {
      // Create test data
      await basePrisma.department.createMany({
        data: [
          { tenantId: TEST_TENANT_ID, code: 'CARD', name: 'Cardiology', resourceStatus: 'ENABLED', createdBy: SYSTEM_USER_ID },
          { tenantId: TEST_TENANT_ID, code: 'RAD', name: 'Radiology', resourceStatus: 'ENABLED', createdBy: SYSTEM_USER_ID },
          { tenantId: TEST_TENANT_ID, code: 'LAB', name: 'Laboratory', resourceStatus: 'DISABLED', createdBy: SYSTEM_USER_ID },
          { tenantId: TEST_TENANT_ID, code: 'OLD-DEPT', name: 'Old Department', resourceStatus: 'DELETED', createdBy: SYSTEM_USER_ID },
        ],
      });
    });

    it('should apply soft-delete filter with OR conditions', async () => {
      const results = await extendedPrisma.department.findMany({
        where: {
          tenantId: TEST_TENANT_ID,
          OR: [
            { code: { startsWith: 'CARD' } },
            { code: { startsWith: 'OLD' } },
          ],
        },
      });

      // Should find CARD but not OLD-DEPT (deleted)
      expect(results.length).toBe(1);
      expect(results[0].code).toBe('CARD');
    });

    it('should apply soft-delete filter with AND conditions', async () => {
      const results = await extendedPrisma.department.findMany({
        where: {
          tenantId: TEST_TENANT_ID,
          AND: [
            { name: { contains: 'ology' } },
          ],
        },
      });

      // Should find Cardiology and Radiology (both contain 'ology' and are not deleted)
      expect(results.length).toBe(2);
    });

    it('should apply soft-delete filter with pagination', async () => {
      const page1 = await extendedPrisma.department.findMany({
        where: { tenantId: TEST_TENANT_ID },
        orderBy: { code: 'asc' },
        take: 2,
        skip: 0,
      });

      const page2 = await extendedPrisma.department.findMany({
        where: { tenantId: TEST_TENANT_ID },
        orderBy: { code: 'asc' },
        take: 2,
        skip: 2,
      });

      // Total non-deleted records: 3 (CARD, LAB, RAD)
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);

      // Verify OLD-DEPT is not in any page
      const allCodes = [...page1, ...page2].map((d) => d.code);
      expect(allCodes).not.toContain('OLD-DEPT');
    });

    it('should apply soft-delete filter with select', async () => {
      const results = await extendedPrisma.department.findMany({
        where: { tenantId: TEST_TENANT_ID },
        select: {
          code: true,
          name: true,
          resourceStatus: true,
        },
      });

      // Should not include DELETED records
      expect(results.length).toBe(3);
      expect(results.every((r) => r.resourceStatus !== 'DELETED')).toBe(true);
    });
  });
});
