/**
 * QueryBuilder Unit Tests
 *
 * Tests for the QueryBuilder class that provides a fluent interface
 * for building Prisma queries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryBuilder } from '../queryBuilder';

// Mock database model for testing
interface TestModel {
  id: string;
  name: string;
  email: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  User?: {
    id: string;
    name: string;
  };
  Posts?: Array<{
    id: string;
    title: string;
  }>;
}

// Mock database context
const mockDbContext = {
  findMany: vi.fn(),
};

describe('QueryBuilder', () => {
  let queryBuilder: QueryBuilder<TestModel>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryBuilder = new QueryBuilder<TestModel>(mockDbContext);
  });

  describe('constructor', () => {
    it('should create a new QueryBuilder instance', () => {
      expect(queryBuilder).toBeInstanceOf(QueryBuilder);
    });
  });

  describe('Where', () => {
    it('should add a simple where condition', () => {
      queryBuilder.Where({ status: 'ENABLED' });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toContainEqual({ status: 'ENABLED' });
    });

    it('should add multiple where conditions with AND', () => {
      queryBuilder.Where({ status: 'ENABLED' }).Where({ name: 'Test' });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toHaveLength(2);
      expect(query.where?.AND).toContainEqual({ status: 'ENABLED' });
      expect(query.where?.AND).toContainEqual({ name: 'Test' });
    });

    it('should handle nested relation path with query', () => {
      queryBuilder.Where({
        path: 'User',
        query: { name: 'John' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toContainEqual({ User: { name: 'John' } });
    });

    it('should handle deep nested relation path', () => {
      queryBuilder.Where({
        path: 'User.Profile',
        query: { bio: 'Developer' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toContainEqual({
        User: { Profile: { bio: 'Developer' } },
      });
    });

    it('should handle array relation with $ prefix (some)', () => {
      queryBuilder.Where({
        path: '$Posts',
        query: { title: 'Hello' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toContainEqual({
        Posts: { some: { title: 'Hello' } },
      });
    });

    it('should support method chaining', () => {
      const result = queryBuilder.Where({ status: 'ENABLED' });

      expect(result).toBe(queryBuilder);
    });
  });

  describe('WhereOr', () => {
    it('should add an OR condition', () => {
      queryBuilder.WhereOr({ status: 'ENABLED' });

      const query = queryBuilder.Build();

      expect(query.where?.OR).toContainEqual({ status: 'ENABLED' });
    });

    it('should add multiple OR conditions', () => {
      queryBuilder.WhereOr({ status: 'ENABLED' }).WhereOr({ status: 'DISABLED' });

      const query = queryBuilder.Build();

      expect(query.where?.OR).toHaveLength(2);
    });

    it('should handle nested relation path with query', () => {
      queryBuilder.WhereOr({
        path: 'User',
        query: { name: 'John' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.OR).toContainEqual({ User: { name: 'John' } });
    });

    it('should handle array relation with $ prefix (some)', () => {
      queryBuilder.WhereOr({
        path: '$Posts',
        query: { title: 'Hello' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.OR).toContainEqual({
        Posts: { some: { title: 'Hello' } },
      });
    });
  });

  describe('WhereAnd', () => {
    it('should be an alias for Where', () => {
      queryBuilder.WhereAnd({ status: 'ENABLED' });

      const query = queryBuilder.Build();

      expect(query.where?.AND).toContainEqual({ status: 'ENABLED' });
    });
  });

  describe('WhereNot', () => {
    it('should add a NOT condition', () => {
      queryBuilder.WhereNot({ status: 'DELETED' });

      const query = queryBuilder.Build();

      expect(query.where?.NOT).toContainEqual({ status: 'DELETED' });
    });

    it('should add multiple NOT conditions', () => {
      queryBuilder.WhereNot({ status: 'DELETED' }).WhereNot({ name: 'Excluded' });

      const query = queryBuilder.Build();

      expect(query.where?.NOT).toHaveLength(2);
    });

    it('should handle nested relation path with query', () => {
      queryBuilder.WhereNot({
        path: 'User',
        query: { name: 'Banned' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.NOT).toContainEqual({ User: { name: 'Banned' } });
    });

    it('should handle array relation with $ prefix (some)', () => {
      queryBuilder.WhereNot({
        path: '$Posts',
        query: { status: 'SPAM' },
      });

      const query = queryBuilder.Build();

      expect(query.where?.NOT).toContainEqual({
        Posts: { some: { status: 'SPAM' } },
      });
    });
  });

  describe('Select', () => {
    it('should select specific fields', () => {
      queryBuilder.Select(['id', 'name', 'email']);

      const query = queryBuilder.Build();

      expect(query.select).toEqual({
        id: true,
        name: true,
        email: true,
      });
    });

    it('should return a new QueryBuilder with narrowed type', () => {
      const narrowedBuilder = queryBuilder.Select(['id', 'name']);

      expect(narrowedBuilder).toBeDefined();
    });
  });

  describe('OrderBy', () => {
    it('should add ascending order by default', () => {
      queryBuilder.OrderBy(['createdAt']);

      const query = queryBuilder.Build();

      expect(query.orderBy).toContainEqual({ createdAt: 'asc' });
    });

    it('should add descending order when specified', () => {
      queryBuilder.OrderBy(['createdAt'], 'desc');

      const query = queryBuilder.Build();

      expect(query.orderBy).toContainEqual({ createdAt: 'desc' });
    });

    it('should add multiple order by fields', () => {
      queryBuilder.OrderBy(['createdAt', 'name'], 'desc');

      const query = queryBuilder.Build();

      expect(query.orderBy).toHaveLength(2);
      expect(query.orderBy).toContainEqual({ createdAt: 'desc' });
      expect(query.orderBy).toContainEqual({ name: 'desc' });
    });

    it('should support chaining multiple OrderBy calls', () => {
      queryBuilder.OrderBy(['createdAt'], 'desc').OrderBy(['name'], 'asc');

      const query = queryBuilder.Build();

      expect(query.orderBy).toHaveLength(2);
      expect(query.orderBy).toContainEqual({ createdAt: 'desc' });
      expect(query.orderBy).toContainEqual({ name: 'asc' });
    });
  });

  describe('Take', () => {
    it('should set the take limit', () => {
      queryBuilder.Take(10);

      const query = queryBuilder.Build();

      expect(query.take).toBe(10);
    });

    it('should override previous take value', () => {
      queryBuilder.Take(10).Take(20);

      const query = queryBuilder.Build();

      expect(query.take).toBe(20);
    });
  });

  describe('Skip', () => {
    it('should set the skip offset', () => {
      queryBuilder.Skip(5);

      const query = queryBuilder.Build();

      expect(query.skip).toBe(5);
    });

    it('should override previous skip value', () => {
      queryBuilder.Skip(5).Skip(10);

      const query = queryBuilder.Build();

      expect(query.skip).toBe(10);
    });
  });

  describe('Include', () => {
    it('should include a relation with boolean', () => {
      queryBuilder.Include({ User: true });

      const query = queryBuilder.Build();

      expect(query.include).toEqual({ User: true });
    });

    it('should include multiple relations', () => {
      queryBuilder.Include({ User: true, Posts: true });

      const query = queryBuilder.Build();

      expect(query.include).toEqual({ User: true, Posts: true });
    });

    it('should include nested relations', () => {
      queryBuilder.Include({
        User: {
          include: {
            Profile: true,
          },
        },
      } as any);

      const query = queryBuilder.Build();

      expect(query.include).toHaveProperty('User');
    });

    it('should support chaining multiple Include calls', () => {
      queryBuilder.Include({ User: true }).Include({ Posts: true });

      const query = queryBuilder.Build();

      expect(query.include).toEqual({ User: true, Posts: true });
    });
  });

  describe('CountRelation', () => {
    it('should add relation count to include', () => {
      queryBuilder.CountRelation('Posts' as keyof TestModel);

      const query = queryBuilder.Build();

      expect(query.include?._count).toEqual({
        select: { Posts: true },
      });
    });

    it('should add relation count with alias', () => {
      queryBuilder.CountRelation('Posts' as keyof TestModel, 'postCount');

      const query = queryBuilder.Build();

      expect(query.include?._count).toEqual({
        select: { postCount: true },
      });
    });

    it('should add multiple relation counts', () => {
      queryBuilder.CountRelation('Posts' as keyof TestModel).CountRelation('User' as keyof TestModel, 'userCount');

      const query = queryBuilder.Build();

      expect(query.include?._count?.select).toHaveProperty('Posts', true);
      expect(query.include?._count?.select).toHaveProperty('userCount', true);
    });
  });

  describe('Build', () => {
    it('should build a complete query object', () => {
      queryBuilder
        .Where({ status: 'ENABLED' })
        .WhereNot({ status: 'DELETED' })
        .Include({ User: true })
        .OrderBy(['createdAt'], 'desc')
        .Skip(0)
        .Take(10);

      const query = queryBuilder.Build();

      expect(query).toHaveProperty('where');
      expect(query).toHaveProperty('orderBy');
      expect(query).toHaveProperty('take', 10);
      expect(query).toHaveProperty('skip', 0);
      expect(query).toHaveProperty('include');
    });

    it('should not include select if not specified', () => {
      queryBuilder.Where({ status: 'ENABLED' });

      const query = queryBuilder.Build();

      expect(query.select).toBeUndefined();
    });

    it('should include select when specified', () => {
      queryBuilder.Select(['id', 'name']);

      const query = queryBuilder.Build();

      expect(query.select).toBeDefined();
    });
  });

  describe('Debug', () => {
    it('should log the query to console', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      queryBuilder.Where({ status: 'ENABLED' }).Debug();

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toBe('Prisma Query:');

      consoleSpy.mockRestore();
    });
  });

  describe('ToList', () => {
    it('should execute findMany with built query', async () => {
      const mockResults = [
        { id: '1', name: 'Test 1' },
        { id: '2', name: 'Test 2' },
      ];
      mockDbContext.findMany.mockResolvedValue(mockResults);

      queryBuilder.Where({ status: 'ENABLED' }).Take(10);

      const results = await queryBuilder.ToList();

      expect(mockDbContext.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.any(Object),
          take: 10,
        }),
      );
      expect(results).toEqual(mockResults);
    });

    it('should pass all query options to findMany', async () => {
      mockDbContext.findMany.mockResolvedValue([]);

      queryBuilder.Where({ status: 'ENABLED' }).Include({ User: true }).OrderBy(['createdAt'], 'desc').Skip(5).Take(10);

      await queryBuilder.ToList();

      expect(mockDbContext.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        select: undefined,
        orderBy: expect.any(Array),
        take: 10,
        skip: 5,
        include: { User: true },
      });
    });
  });

  describe('Single', () => {
    // Note: Single() method uses Array.filter() internally which expects a function predicate,
    // but the Predicate type is defined as an object. These tests use 'as any' to work around
    // the type mismatch. The implementation should be updated to either:
    // 1. Accept a separate FilterPredicate function type
    // 2. Or convert object predicates to filter functions internally

    it('should return single matching result', async () => {
      const mockResults = [{ id: '1', name: 'Test', status: 'ENABLED' }];
      mockDbContext.findMany.mockResolvedValue(mockResults);

      // Use function predicate as that's what the implementation expects
      const result = await queryBuilder.Single(((item: TestModel) => item.id === '1') as any);

      expect(result).toEqual(mockResults[0]);
    });

    it('should throw error when no results match', async () => {
      mockDbContext.findMany.mockResolvedValue([]);

      await expect(queryBuilder.Single(((item: TestModel) => item.id === '1') as any)).rejects.toThrow(
        'Single query returned more than one result or no result',
      );
    });

    it('should throw error when multiple results match', async () => {
      const mockResults = [
        { id: '1', name: 'Test 1' },
        { id: '2', name: 'Test 2' },
      ];
      mockDbContext.findMany.mockResolvedValue(mockResults);

      // Both items would pass this predicate
      await expect(queryBuilder.Single((() => true) as any)).rejects.toThrow('Single query returned more than one result or no result');
    });
  });

  describe('Complex Query Scenarios', () => {
    it('should build a complex query with all options', () => {
      queryBuilder
        .Where({ status: 'ENABLED' })
        .Where({ name: { contains: 'test' } })
        .WhereOr({ email: { endsWith: '@example.com' } })
        .WhereNot({ status: 'DELETED' })
        .Include({ User: true, Posts: true })
        .OrderBy(['createdAt'], 'desc')
        .OrderBy(['name'], 'asc')
        .Skip(20)
        .Take(10);

      const query = queryBuilder.Build();

      expect(query.where?.AND).toHaveLength(2);
      expect(query.where?.OR).toHaveLength(1);
      expect(query.where?.NOT).toHaveLength(1);
      expect(query.orderBy).toHaveLength(2);
      expect(query.skip).toBe(20);
      expect(query.take).toBe(10);
      expect(query.include).toEqual({ User: true, Posts: true });
    });

    it('should handle pagination scenario', () => {
      const page = 3;
      const pageSize = 20;

      queryBuilder
        .Where({ status: 'ENABLED' })
        .OrderBy(['createdAt'], 'desc')
        .Skip((page - 1) * pageSize)
        .Take(pageSize);

      const query = queryBuilder.Build();

      expect(query.skip).toBe(40);
      expect(query.take).toBe(20);
    });
  });
});
