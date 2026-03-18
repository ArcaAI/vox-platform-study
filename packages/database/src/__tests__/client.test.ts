/**
 * Prisma Client Soft-Delete Extension Tests
 *
 * Tests for the soft-delete filtering extension that automatically
 * excludes DELETED records from query operations.
 *
 * These tests import and test the ACTUAL applySoftDeleteFilter function
 * from client.ts, not a duplicated version.
 *
 * These tests verify:
 * - Soft-delete filter logic is correct
 * - Filter bypass when resourceStatus is explicitly set
 * - Edge cases and error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client and adapter before importing client.ts
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $extends: vi.fn().mockReturnThis(),
  })),
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
    PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
    PrismaClientInitializationError: class PrismaClientInitializationError extends Error {},
    PrismaClientValidationError: class PrismaClientValidationError extends Error {},
  },
}));

// Mock env.js to prevent actual env loading
vi.mock('../env.js', () => ({}));

// Import the actual function from client.ts
import { applySoftDeleteFilter } from '../client';

describe('Soft-Delete Filter Logic', () => {
  describe('applySoftDeleteFilter', () => {
    it('should add resourceStatus filter when where is undefined', () => {
      const args: { where?: Record<string, unknown> } = {};

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: { not: 'DELETED' },
      });
    });

    it('should add resourceStatus filter when where is empty object', () => {
      const args: { where?: Record<string, unknown> } = { where: {} };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: { not: 'DELETED' },
      });
    });

    it('should preserve existing where conditions', () => {
      const args: { where?: Record<string, unknown> } = {
        where: { name: 'test', tenantId: 'tenant-123' },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        name: 'test',
        tenantId: 'tenant-123',
        resourceStatus: { not: 'DELETED' },
      });
    });

    it('should preserve complex where conditions', () => {
      const args: { where?: Record<string, unknown> } = {
        where: {
          OR: [{ name: 'test1' }, { name: 'test2' }],
          AND: [{ active: true }],
          NOT: { archived: true },
        },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        OR: [{ name: 'test1' }, { name: 'test2' }],
        AND: [{ active: true }],
        NOT: { archived: true },
        resourceStatus: { not: 'DELETED' },
      });
    });

    it('should not override explicit resourceStatus string value', () => {
      const args: { where?: Record<string, unknown> } = {
        where: { resourceStatus: 'DELETED' },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: 'DELETED',
      });
    });

    it('should not override explicit resourceStatus ENABLED', () => {
      const args: { where?: Record<string, unknown> } = {
        where: { resourceStatus: 'ENABLED' },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: 'ENABLED',
      });
    });

    it('should not override resourceStatus with "in" condition', () => {
      const args: { where?: Record<string, unknown> } = {
        where: {
          resourceStatus: { in: ['ENABLED', 'DISABLED'] },
        },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: { in: ['ENABLED', 'DISABLED'] },
      });
    });

    it('should not override resourceStatus with "not" condition', () => {
      const args: { where?: Record<string, unknown> } = {
        where: {
          resourceStatus: { not: 'ARCHIVED' },
        },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: { not: 'ARCHIVED' },
      });
    });

    it('should not override resourceStatus with "notIn" condition', () => {
      const args: { where?: Record<string, unknown> } = {
        where: {
          resourceStatus: { notIn: ['DELETED', 'ARCHIVED'] },
        },
      };

      applySoftDeleteFilter(args);

      expect(args.where).toEqual({
        resourceStatus: { notIn: ['DELETED', 'ARCHIVED'] },
      });
    });

    it('should handle null resourceStatus (falsy but explicit)', () => {
      // Note: null is falsy, so filter will be applied
      // This is expected behavior - use explicit value to bypass
      const args: { where?: Record<string, unknown> } = {
        where: { resourceStatus: null },
      };

      applySoftDeleteFilter(args);

      // null is falsy, so filter is applied
      expect(args.where).toEqual({
        resourceStatus: { not: 'DELETED' },
      });
    });

    it('should handle undefined resourceStatus', () => {
      const args: { where?: Record<string, unknown> } = {
        where: { resourceStatus: undefined, name: 'test' },
      };

      applySoftDeleteFilter(args);

      // undefined is falsy, so filter is applied
      expect(args.where).toEqual({
        name: 'test',
        resourceStatus: { not: 'DELETED' },
      });
    });
  });
});

describe('Filter Bypass Scenarios', () => {
  it('should allow querying only DELETED records', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: 'DELETED' },
    };

    applySoftDeleteFilter(args);

    // Filter should NOT be applied because resourceStatus is explicitly set
    expect(args.where?.resourceStatus).toBe('DELETED');
  });

  it('should allow querying specific statuses including DELETED', () => {
    const args: { where?: Record<string, unknown> } = {
      where: {
        resourceStatus: { in: ['ENABLED', 'DELETED'] },
      },
    };

    applySoftDeleteFilter(args);

    expect(args.where?.resourceStatus).toEqual({ in: ['ENABLED', 'DELETED'] });
  });
});

describe('Edge Cases and Error Handling', () => {
  it('should handle deeply nested where conditions', () => {
    const args: { where?: Record<string, unknown> } = {
      where: {
        AND: [
          { OR: [{ name: 'a' }, { name: 'b' }] },
          { NOT: { archived: true } },
        ],
        nested: {
          field: { equals: 'value' },
        },
      },
    };

    applySoftDeleteFilter(args);

    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
    expect(args.where?.AND).toBeDefined();
    expect(args.where?.nested).toBeDefined();
  });

  it('should handle where with array values', () => {
    const args: { where?: Record<string, unknown> } = {
      where: {
        id: { in: ['id1', 'id2', 'id3'] },
        tags: { hasSome: ['tag1', 'tag2'] },
      },
    };

    applySoftDeleteFilter(args);

    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
    expect(args.where?.id).toEqual({ in: ['id1', 'id2', 'id3'] });
  });

  it('should handle where with date conditions', () => {
    const now = new Date();
    const args: { where?: Record<string, unknown> } = {
      where: {
        createdAt: { gte: now },
        updatedAt: { lte: now },
      },
    };

    applySoftDeleteFilter(args);

    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
    expect(args.where?.createdAt).toEqual({ gte: now });
  });

  it('should handle empty string resourceStatus (falsy)', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: '' },
    };

    applySoftDeleteFilter(args);

    // Empty string is falsy, so filter is applied
    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
  });

  it('should handle resourceStatus: 0 (falsy number)', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: 0 },
    };

    applySoftDeleteFilter(args);

    // 0 is falsy, so filter is applied
    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
  });

  it('should handle resourceStatus: false (falsy boolean)', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: false },
    };

    applySoftDeleteFilter(args);

    // false is falsy, so filter is applied
    expect(args.where?.resourceStatus).toEqual({ not: 'DELETED' });
  });

  it('should preserve resourceStatus when truthy object', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: { equals: 'ENABLED' } },
    };

    applySoftDeleteFilter(args);

    // Object is truthy, so filter is NOT applied
    expect(args.where?.resourceStatus).toEqual({ equals: 'ENABLED' });
  });
});
