/**
 * Repository Soft-Delete Integration Tests
 *
 * End-to-end tests that verify the Repository layer's soft-delete functionality
 * against a real PostgreSQL database. These tests use the DepartmentRepository
 * as a concrete example.
 *
 * Prerequisites:
 *   1. Start test infrastructure: pnpm docker:test:up
 *   2. Push schema: pnpm test:db:push
 *   3. Run tests: pnpm test:integration
 *
 * Test Coverage:
 *   - Repository.softDelete() method
 *   - Repository.restore() method
 *   - Soft-delete filtering in findAll, findFirst, findById
 *   - Change tracking for soft-delete operations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture, tenant context not yet established
import { getPlatformAdminPrismaClient_Unscoped, getExtendedPrismaClient, CorePrismaClient } from '@arcaai/database';
import { DepartmentRepository } from '../repositories/generated/core/DepartmentRepository';
import { DepartmentFactory } from '../factories/generated/core/DepartmentFactory';
import { ResourceStatusType } from '../enums';

// Test data constants
const TEST_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';
const TEST_USER_ID = '70000000-0000-0000-0000-000000000001';

/**
 * Minimal UnitOfWork stub that returns the extended Prisma client directly.
 * Avoids pulling in NestJS DI / ClsService for a pure repository integration test.
 */
function createUnitOfWorkStub() {
  const extendedClient = getExtendedPrismaClient();
  return {
    getDatabaseService: () => extendedClient,
    startTransaction: async () => {},
    endTransaction: () => {},
  };
}

describe('Repository Soft-Delete Integration Tests', () => {
  let departmentRepository: DepartmentRepository;
  let basePrisma: CorePrismaClient;

  beforeAll(async () => {
    const unitOfWork = createUnitOfWorkStub();
    departmentRepository = new DepartmentRepository(unitOfWork as any);
    basePrisma = getPlatformAdminPrismaClient_Unscoped();

    await basePrisma.$connect();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await basePrisma.$executeRaw`
      DELETE FROM core."Department" WHERE "tenantId" = ${TEST_TENANT_ID}
    `;
  });

  describe('Repository.softDelete()', () => {
    it('should soft delete an entity by setting resourceStatus to DELETED', async () => {
      // Create a department
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'SOFT-DEL-TEST',
        name: 'Soft Delete Test Department',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);
      expect(created.resourceStatus).toBe(ResourceStatusType.ENABLED);

      // Soft delete
      const deleted = await departmentRepository.softDelete(created.id);

      expect(deleted.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(deleted.resourceStatusUpdatedAt).not.toBeNull();
    });

    it('should soft delete with updatedBy tracking', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'SOFT-DEL-USER',
        name: 'Soft Delete User Tracking',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Soft delete with user tracking
      const deleted = await departmentRepository.softDelete(created.id, TEST_USER_ID);

      expect(deleted.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(deleted.resourceStatusUpdatedBy).toBe(TEST_USER_ID);
    });

    it('should make entity invisible to normal queries after soft delete', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'INVISIBLE-TEST',
        name: 'Invisible After Delete',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Soft delete
      await departmentRepository.softDelete(created.id);

      // Try to find with repository (should not find due to soft-delete filter)
      const results = await departmentRepository.findAllByTenant(TEST_TENANT_ID);

      expect(results.find((d) => d.code === 'INVISIBLE-TEST')).toBeUndefined();
    });
  });

  describe('Repository.restore()', () => {
    it('should restore a soft-deleted entity by setting resourceStatus to ENABLED', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'RESTORE-TEST',
        name: 'Restore Test Department',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Soft delete
      await departmentRepository.softDelete(created.id);

      // Restore
      const restored = await departmentRepository.restore(created.id);

      expect(restored.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(restored.resourceStatusUpdatedAt).not.toBeNull();
    });

    it('should restore with updatedBy tracking', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'RESTORE-USER',
        name: 'Restore User Tracking',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);
      await departmentRepository.softDelete(created.id);

      // Restore with user tracking
      const restored = await departmentRepository.restore(created.id, TEST_USER_ID);

      expect(restored.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(restored.resourceStatusUpdatedBy).toBe(TEST_USER_ID);
    });

    it('should make entity visible to normal queries after restore', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'VISIBLE-AFTER-RESTORE',
        name: 'Visible After Restore',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Soft delete
      await departmentRepository.softDelete(created.id);

      // Verify invisible
      let results = await departmentRepository.findAllByTenant(TEST_TENANT_ID);
      expect(results.find((d) => d.code === 'VISIBLE-AFTER-RESTORE')).toBeUndefined();

      // Restore
      await departmentRepository.restore(created.id);

      // Verify visible
      results = await departmentRepository.findAllByTenant(TEST_TENANT_ID);
      expect(results.find((d) => d.code === 'VISIBLE-AFTER-RESTORE')).toBeDefined();
    });
  });

  describe('Soft-Delete Filtering in Repository Methods', () => {
    beforeEach(async () => {
      // Create test departments with different statuses
      const departments = [
        { code: 'ENABLED-1', name: 'Enabled 1', resourceStatus: 'ENABLED' },
        { code: 'ENABLED-2', name: 'Enabled 2', resourceStatus: 'ENABLED' },
        { code: 'DISABLED-1', name: 'Disabled 1', resourceStatus: 'DISABLED' },
        { code: 'DELETED-1', name: 'Deleted 1', resourceStatus: 'DELETED' },
        { code: 'DELETED-2', name: 'Deleted 2', resourceStatus: 'DELETED' },
      ];

      for (const dept of departments) {
        await basePrisma.department.create({
          data: {
            tenantId: TEST_TENANT_ID,
            code: dept.code,
            name: dept.name,
            resourceStatus: dept.resourceStatus as any,
            createdBy: SYSTEM_USER_ID,
          },
        });
      }
    });

    it('findAll should exclude DELETED records', async () => {
      const results = await departmentRepository.findAll({
        filters: { tenantId: TEST_TENANT_ID } as any,
      });

      // Should return 3 records (2 ENABLED + 1 DISABLED)
      expect(results.length).toBe(3);
      expect(results.every((d) => d.resourceStatus !== ResourceStatusType.DELETED)).toBe(true);
    });

    it('findAllByTenant should return only ENABLED records', async () => {
      const results = await departmentRepository.findAllByTenant(TEST_TENANT_ID);

      // findAllByTenant filters by resourceStatus=ENABLED, so only 2 ENABLED records
      expect(results.length).toBe(2);
      expect(results.every((d) => d.resourceStatus === ResourceStatusType.ENABLED)).toBe(true);
      expect(results.map((d) => d.code)).not.toContain('DELETED-1');
      expect(results.map((d) => d.code)).not.toContain('DELETED-2');
      expect(results.map((d) => d.code)).not.toContain('DISABLED-1');
    });

    it('findByCode should not find DELETED records', async () => {
      // Create a deleted department with known code
      await basePrisma.department.create({
        data: {
          tenantId: TEST_TENANT_ID,
          code: 'DELETED-CODE',
          name: 'Deleted by Code',
          resourceStatus: 'DELETED',
          createdBy: SYSTEM_USER_ID,
        },
      });

      const result = await departmentRepository.findByCode(TEST_TENANT_ID, 'DELETED-CODE');

      expect(result).toBeNull();
    });

    it('count should exclude DELETED records', async () => {
      const count = await departmentRepository.count({
        filters: { tenantId: TEST_TENANT_ID } as any,
      });

      // Should count 3 (2 ENABLED + 1 DISABLED)
      expect(count).toBe(3);
    });
  });

  describe('Soft-Delete and Restore Lifecycle', () => {
    it('should support full soft-delete and restore cycle', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'LIFECYCLE-TEST',
        name: 'Lifecycle Test',
        createdBy: SYSTEM_USER_ID,
      });

      // Create
      const created = await departmentRepository.create(entity);
      expect(created.resourceStatus).toBe(ResourceStatusType.ENABLED);

      // Verify visible
      let found = await departmentRepository.findByCode(TEST_TENANT_ID, 'LIFECYCLE-TEST');
      expect(found).not.toBeNull();

      // Soft delete
      const deleted = await departmentRepository.softDelete(created.id, TEST_USER_ID);
      expect(deleted.resourceStatus).toBe(ResourceStatusType.DELETED);

      // Verify invisible
      found = await departmentRepository.findByCode(TEST_TENANT_ID, 'LIFECYCLE-TEST');
      expect(found).toBeNull();

      // Restore
      const restored = await departmentRepository.restore(created.id, TEST_USER_ID);
      expect(restored.resourceStatus).toBe(ResourceStatusType.ENABLED);

      // Verify visible again
      found = await departmentRepository.findByCode(TEST_TENANT_ID, 'LIFECYCLE-TEST');
      expect(found).not.toBeNull();
    });

    it('should preserve entity data through soft-delete and restore', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'DATA-PRESERVE',
        name: 'Data Preservation Test',
        description: 'This description should be preserved',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Soft delete and restore
      await departmentRepository.softDelete(created.id);
      const restored = await departmentRepository.restore(created.id);

      // Verify all data is preserved
      expect(restored.code).toBe('DATA-PRESERVE');
      expect(restored.name).toBe('Data Preservation Test');
      expect(restored.description).toBe('This description should be preserved');
      expect(restored.tenantId).toBe(TEST_TENANT_ID);
    });
  });

  describe('Edge Cases', () => {
    it('should handle soft-deleting an already deleted record', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'DOUBLE-DELETE',
        name: 'Double Delete Test',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // First soft delete
      await departmentRepository.softDelete(created.id);

      // Second soft delete (should still work)
      const doubleDeleted = await departmentRepository.softDelete(created.id);

      expect(doubleDeleted.resourceStatus).toBe(ResourceStatusType.DELETED);
    });

    it('should handle restoring an already enabled record', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'DOUBLE-RESTORE',
        name: 'Double Restore Test',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);

      // Restore without prior delete (should still work)
      const restored = await departmentRepository.restore(created.id);

      expect(restored.resourceStatus).toBe(ResourceStatusType.ENABLED);
    });

    it('should update resourceStatusUpdatedAt on each operation', async () => {
      const entity = DepartmentFactory.CreateDepartment({
        tenantId: TEST_TENANT_ID,
        code: 'TIMESTAMP-TEST',
        name: 'Timestamp Test',
        createdBy: SYSTEM_USER_ID,
      });

      const created = await departmentRepository.create(entity);
      const createdTimestamp = created.resourceStatusUpdatedAt;

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Soft delete
      const deleted = await departmentRepository.softDelete(created.id);
      const deletedTimestamp = deleted.resourceStatusUpdatedAt;

      expect(deletedTimestamp?.getTime()).toBeGreaterThan(createdTimestamp?.getTime() || 0);

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Restore
      const restored = await departmentRepository.restore(created.id);
      const restoredTimestamp = restored.resourceStatusUpdatedAt;

      expect(restoredTimestamp?.getTime()).toBeGreaterThan(deletedTimestamp?.getTime() || 0);
    });
  });
});
