/**
 * Repository Helpers Unit Tests
 *
 * Tests for the formatFindAllProps and formatCountProps helper functions
 * that format query parameters for Prisma operations.
 */

import { describe, it, expect } from 'vitest';
import { formatFindAllProps, formatCountProps } from '../repository.helpers';

// Mock database model for testing
interface TestModel {
  id: string;
  name: string;
  email: string;
  status: string;
  tenantId: string;
  createdAt: Date;
}

describe('formatFindAllProps', () => {
  describe('pagination', () => {
    it('should calculate skip correctly for page 1', () => {
      const result = formatFindAllProps<TestModel>({
        page: 1,
        limit: 10,
      });

      expect(result.skip).toBe(0);
      expect(result.take).toBe(10);
    });

    it('should calculate skip correctly for page 2', () => {
      const result = formatFindAllProps<TestModel>({
        page: 2,
        limit: 10,
      });

      expect(result.skip).toBe(10);
      expect(result.take).toBe(10);
    });

    it('should calculate skip correctly for page 5 with limit 20', () => {
      const result = formatFindAllProps<TestModel>({
        page: 5,
        limit: 20,
      });

      expect(result.skip).toBe(80);
      expect(result.take).toBe(20);
    });

    it('should set skip to 0 when page is not provided', () => {
      const result = formatFindAllProps<TestModel>({
        limit: 10,
      });

      expect(result.skip).toBe(0);
    });

    it('should set skip to 0 when limit is not provided', () => {
      const result = formatFindAllProps<TestModel>({
        page: 5,
      });

      expect(result.skip).toBe(0);
    });

    it('should set skip to 0 when page is 0 and limit is provided', () => {
      const result = formatFindAllProps<TestModel>({
        page: 0,
        limit: 10,
      });

      expect(result.skip).toBe(0);
      expect(result.take).toBe(10);
    });

    it('should handle undefined page and limit', () => {
      const result = formatFindAllProps<TestModel>({});

      expect(result.skip).toBe(0);
      expect(result.take).toBeUndefined();
    });
  });

  describe('filters', () => {
    it('should pass through simple filters', () => {
      const result = formatFindAllProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
      });

      expect(result.where).toEqual({ status: 'ENABLED' });
    });

    it('should pass through filters with AND conditions', () => {
      const result = formatFindAllProps<TestModel>({
        filters: {
          AND: [{ status: 'ENABLED' }, { tenantId: 'tenant-1' }],
        } as any,
      });

      expect(result.where.AND).toHaveLength(2);
    });
  });

  describe('where conditions', () => {
    it('should pass through simple where conditions', () => {
      const result = formatFindAllProps<TestModel>({
        where: { id: 'test-id' } as any,
      });

      expect(result.where).toEqual({ id: 'test-id' });
    });

    it('should merge filters and where conditions', () => {
      const result = formatFindAllProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        where: { tenantId: 'tenant-1' } as any,
      });

      expect(result.where).toHaveProperty('status', 'ENABLED');
      expect(result.where).toHaveProperty('tenantId', 'tenant-1');
    });

    it('should merge filters.AND and where.AND into single AND array', () => {
      const result = formatFindAllProps<TestModel>({
        filters: {
          AND: [{ status: 'ENABLED' }],
        } as any,
        where: {
          AND: [{ tenantId: 'tenant-1' }],
        } as any,
      });

      expect(result.where.AND).toHaveLength(2);
      expect(result.where.AND).toContainEqual({ status: 'ENABLED' });
      expect(result.where.AND).toContainEqual({ tenantId: 'tenant-1' });
    });

    it('should add where to filters.AND when filters has AND but where does not', () => {
      const result = formatFindAllProps<TestModel>({
        filters: {
          AND: [{ status: 'ENABLED' }],
        } as any,
        where: { tenantId: 'tenant-1' } as any,
      });

      expect(result.where.AND).toContainEqual({ status: 'ENABLED' });
      expect(result.where.AND).toContainEqual({ tenantId: 'tenant-1' });
    });

    it('should add filters to where.AND when where has AND but filters does not', () => {
      const result = formatFindAllProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        where: {
          AND: [{ tenantId: 'tenant-1' }],
        } as any,
      });

      expect(result.where.AND).toContainEqual({ tenantId: 'tenant-1' });
      expect(result.where.AND).toContainEqual({ status: 'ENABLED' });
    });
  });

  describe('search', () => {
    it('should add search conditions when search and searchFields are provided', () => {
      const result = formatFindAllProps<TestModel>({
        search: 'test',
        searchFields: ['name', 'email'],
      });

      expect(result.where.AND).toBeDefined();
      expect(result.where.AND).toHaveLength(1);
      expect(result.where.AND[0]).toHaveProperty('OR');
      expect(result.where.AND[0].OR).toHaveLength(2);
    });

    it('should create case-insensitive contains conditions for each search field', () => {
      const result = formatFindAllProps<TestModel>({
        search: 'test',
        searchFields: ['name', 'email'],
      });

      const orConditions = result.where.AND[0].OR;
      expect(orConditions).toContainEqual({
        name: { contains: 'test', mode: 'insensitive' },
      });
      expect(orConditions).toContainEqual({
        email: { contains: 'test', mode: 'insensitive' },
      });
    });

    it('should add search to existing AND conditions', () => {
      const result = formatFindAllProps<TestModel>({
        filters: {
          AND: [{ status: 'ENABLED' }],
        } as any,
        search: 'test',
        searchFields: ['name'],
      });

      expect(result.where.AND).toHaveLength(2);
      expect(result.where.AND[0]).toEqual({ status: 'ENABLED' });
      expect(result.where.AND[1]).toHaveProperty('OR');
    });

    it('should not add search conditions when search is empty', () => {
      const result = formatFindAllProps<TestModel>({
        search: '',
        searchFields: ['name'],
      });

      expect(result.where).toEqual({});
    });

    it('should not add search conditions when searchFields is empty array', () => {
      const result = formatFindAllProps<TestModel>({
        search: 'test',
        searchFields: [],
      });

      expect(result.where).toEqual({});
    });

    it('should not add search conditions when searchFields is undefined', () => {
      const result = formatFindAllProps<TestModel>({
        search: 'test',
      });

      expect(result.where).toEqual({});
    });
  });

  describe('sort', () => {
    it('should format single sort option', () => {
      const result = formatFindAllProps<TestModel>({
        sort: [{ createdAt: 'desc' }],
      });

      expect(result.orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('should format multiple sort options', () => {
      const result = formatFindAllProps<TestModel>({
        sort: [{ createdAt: 'desc' }, { name: 'asc' }],
      });

      expect(result.orderBy).toHaveLength(2);
      expect(result.orderBy).toContainEqual({ createdAt: 'desc' });
      expect(result.orderBy).toContainEqual({ name: 'asc' });
    });

    it('should return undefined orderBy when sort is not provided', () => {
      const result = formatFindAllProps<TestModel>({});

      expect(result.orderBy).toBeUndefined();
    });

    it('should return undefined orderBy when sort is empty array', () => {
      const result = formatFindAllProps<TestModel>({
        sort: [],
      });

      expect(result.orderBy).toBeUndefined();
    });
  });

  describe('complete scenarios', () => {
    it('should handle all options together', () => {
      const result = formatFindAllProps<TestModel>({
        page: 2,
        limit: 20,
        filters: { status: 'ENABLED' } as any,
        search: 'test',
        searchFields: ['name', 'email'],
        sort: [{ createdAt: 'desc' }],
      });

      expect(result.skip).toBe(20);
      expect(result.take).toBe(20);
      expect(result.where).toBeDefined();
      expect(result.orderBy).toEqual([{ createdAt: 'desc' }]);
    });
  });
});

describe('formatCountProps', () => {
  describe('filters', () => {
    it('should pass through simple filters', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
      });

      expect(result.where).toEqual({ status: 'ENABLED' });
    });

    it('should handle empty filters', () => {
      const result = formatCountProps<TestModel>({});

      expect(result.where).toEqual({});
    });
  });

  describe('where conditions', () => {
    it('should combine where and filters with AND', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        where: { tenantId: 'tenant-1' } as any,
      });

      const where = result.where as any;
      expect(where.AND).toBeDefined();
      expect(where.AND).toContainEqual({ tenantId: 'tenant-1' });
      expect(where.AND).toContainEqual({ status: 'ENABLED' });
    });

    it('should handle where without filters', () => {
      const result = formatCountProps<TestModel>({
        where: { tenantId: 'tenant-1' } as any,
      });

      const where = result.where as any;
      expect(where.AND).toBeDefined();
      expect(where.AND).toContainEqual({ tenantId: 'tenant-1' });
    });
  });

  describe('search', () => {
    it('should add search conditions when search and searchFields are provided', () => {
      const result = formatCountProps<TestModel>({
        search: 'test',
        searchFields: ['name', 'email'],
      });

      const where = result.where as any;
      expect(where.AND).toBeDefined();
      expect(where.AND).toHaveLength(2);
    });

    it('should create case-insensitive contains conditions for each search field', () => {
      const result = formatCountProps<TestModel>({
        search: 'test',
        searchFields: ['name'],
      });

      const where = result.where as any;
      const orCondition = where.AND[1];
      expect(orCondition.OR).toContainEqual({
        name: { contains: 'test', mode: 'insensitive' },
      });
    });

    it('should combine filters, where, and search', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        where: { tenantId: 'tenant-1' } as any,
        search: 'test',
        searchFields: ['name'],
      });

      const where = result.where as any;
      expect(where.AND).toBeDefined();
      // Should have the combined where+filters AND the search OR
      expect(where.AND.length).toBeGreaterThanOrEqual(2);
    });

    it('should not add search conditions when search is empty', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        search: '',
        searchFields: ['name'],
      });

      expect(result.where).toEqual({ status: 'ENABLED' });
    });

    it('should not add search conditions when searchFields is undefined', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        search: 'test',
      });

      expect(result.where).toEqual({ status: 'ENABLED' });
    });

    it('should not add search conditions when searchFields is empty array', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        search: 'test',
        searchFields: [],
      });

      expect(result.where).toEqual({ status: 'ENABLED' });
    });
  });

  describe('complete scenarios', () => {
    it('should handle all options together', () => {
      const result = formatCountProps<TestModel>({
        filters: { status: 'ENABLED' } as any,
        where: { tenantId: 'tenant-1' } as any,
        search: 'test',
        searchFields: ['name', 'email'],
      });

      const where = result.where as any;
      expect(result.where).toBeDefined();
      expect(where.AND).toBeDefined();
    });

    it('should handle only search without filters or where', () => {
      const result = formatCountProps<TestModel>({
        search: 'test',
        searchFields: ['name'],
      });

      const where = result.where as any;
      expect(where.AND).toBeDefined();
      expect(where.AND[1].OR).toContainEqual({
        name: { contains: 'test', mode: 'insensitive' },
      });
    });
  });
});

/**
 * regression — `formatFindAllProps` used to branch on which side
 * carried an `AND` and keep ONLY that array, discarding every sibling scalar
 * key. A `where` carrying BOTH `tenantId` and an `AND` therefore lost its
 * tenant scope and read across tenants, while `formatCountProps` counted the
 * right rows — surfacing as a page whose contents disagreed with its count.
 */
describe('formatFindAllProps — where/filters merge keeps BOTH halves', () => {
  it('keeps sibling scalar keys when `where` also carries an AND (the tenant-scope leak)', () => {
    const result = formatFindAllProps({
      page: 1,
      limit: 10,
      where: {
        tenantId: 'tenant-1',
        externalPatientId: 'PAT-1',
        AND: [{ OR: [{ revokedAt: null }] }],
      },
    } as never);

    expect(result.where.tenantId, 'tenantId must survive — dropping it reads across tenants').toBe('tenant-1');
    expect(result.where.externalPatientId).toBe('PAT-1');
    expect(result.where.AND).toEqual([{ OR: [{ revokedAt: null }] }]);
  });

  it('keeps sibling scalar keys when `filters` carries the AND', () => {
    const result = formatFindAllProps({
      page: 1,
      limit: 10,
      filters: { status: 'ENABLED', AND: [{ a: 1 }] },
      where: { tenantId: 'tenant-1' },
    } as never);

    // `filters`' own sibling survives at the top level; the AND-less `where` is
    // pushed INTO the AND array (the long-standing shape this file pins
    // elsewhere). Position differs, but both conditions are applied — which is
    // all Prisma cares about, and all that was broken.
    expect(result.where.status).toBe('ENABLED');
    expect(result.where.AND).toContainEqual({ a: 1 });
    expect(result.where.AND).toContainEqual({ tenantId: 'tenant-1' });
  });

  it('concatenates both AND arrays when both sides carry one, keeping both sets of scalars', () => {
    const result = formatFindAllProps({
      page: 1,
      limit: 10,
      filters: { status: 'ENABLED', AND: [{ a: 1 }] },
      where: { tenantId: 'tenant-1', AND: [{ b: 2 }] },
    } as never);

    expect(result.where.tenantId).toBe('tenant-1');
    expect(result.where.status).toBe('ENABLED');
    expect(result.where.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('does not mutate the caller’s filters.AND array', () => {
    const filters = { AND: [{ a: 1 }] };
    formatFindAllProps({ page: 1, limit: 10, filters, where: { tenantId: 't' } } as never);

    expect(filters.AND, 'the caller’s array must be left alone').toEqual([{ a: 1 }]);
  });

  it('agrees with formatCountProps on which rows match', () => {
    const props = { where: { tenantId: 'tenant-1', AND: [{ OR: [{ revokedAt: null }] }] } };
    const list = formatFindAllProps({ page: 1, limit: 10, ...props } as never);
    const count = formatCountProps(props as never);

    // Both must constrain by tenant; before the fix only the count did.
    expect(list.where.tenantId).toBe('tenant-1');
    expect(JSON.stringify(count.where)).toContain('tenant-1');
  });
});
