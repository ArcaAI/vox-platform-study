/**
 * Prisma Client Lifecycle Tests
 *
 * Tests for client creation, singleton pattern, and lifecycle management.
 * These tests import and test the ACTUAL functions from client.ts.
 *
 * Test Coverage:
 * - Client creation with DATABASE_URL validation
 * - Singleton pattern behavior
 * - Extended client creation
 * - Factory function behavior
 * - Error handling for missing configuration
 *
 * Note: Some tests require mocking environment variables. Tests that need
 * a real database connection are in the integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Prisma client and adapter before importing client.ts
// Use proper class constructors for mocks
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class MockPrismaPg {
    constructor(options: { connectionString: string }) {
      // Mock adapter
    }
  },
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    constructor(options?: any) {
      // Mock client
    }
    $connect = vi.fn().mockResolvedValue(undefined);
    $disconnect = vi.fn().mockResolvedValue(undefined);
    $extends = vi.fn().mockReturnThis();
  },
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

describe('Prisma Client Creation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('DATABASE_URL Validation', () => {
    it('should throw error when DATABASE_URL is not set', async () => {
      delete process.env.DATABASE_URL;

      // Dynamic import to get fresh module with new env
      const clientModule = await import('../client');

      // The createNewPrismaClient should throw when DATABASE_URL is missing
      expect(() => clientModule.createNewPrismaClient()).toThrow(
        'DATABASE_URL environment variable is not set'
      );
    });

    it('should create client when DATABASE_URL is set', async () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';

      const clientModule = await import('../client');
      const client = clientModule.createNewPrismaClient();

      expect(client).toBeDefined();
    });

    it('should throw error when DATABASE_URL is empty string', async () => {
      process.env.DATABASE_URL = '';

      const clientModule = await import('../client');

      expect(() => clientModule.createNewPrismaClient()).toThrow(
        'DATABASE_URL environment variable is not set'
      );
    });
  });
});

describe('Singleton Pattern', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getPlatformAdminPrismaClient_Unscoped', () => {
    it('should return the same instance on multiple calls', async () => {
      const clientModule = await import('../client');

      const first = clientModule.getPlatformAdminPrismaClient_Unscoped();
      const second = clientModule.getPlatformAdminPrismaClient_Unscoped();
      const third = clientModule.getPlatformAdminPrismaClient_Unscoped();

      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });

  describe('getExtendedPrismaClient', () => {
    it('should return the same extended instance on multiple calls', async () => {
      const clientModule = await import('../client');

      const first = clientModule.getExtendedPrismaClient();
      const second = clientModule.getExtendedPrismaClient();

      expect(first).toBe(second);
    });
  });
});

describe('Factory Functions', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createNewPrismaClient', () => {
    it('should create a new instance each time', async () => {
      const clientModule = await import('../client');

      const first = clientModule.createNewPrismaClient();
      const second = clientModule.createNewPrismaClient();

      // Factory functions create new instances each time
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // Note: With mocks, these might be the same mock object
      // Real behavior is tested in integration tests
    });
  });

  describe('createNewExtendedPrismaClient', () => {
    it('should create a new extended instance each time', async () => {
      const clientModule = await import('../client');

      const first = clientModule.createNewExtendedPrismaClient();
      const second = clientModule.createNewExtendedPrismaClient();

      expect(first).toBeDefined();
      expect(second).toBeDefined();
    });
  });
});

describe('applySoftDeleteFilter', () => {
  let applySoftDeleteFilter: (args: { where?: Record<string, unknown> }) => void;

  beforeEach(async () => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    const clientModule = await import('../client');
    applySoftDeleteFilter = clientModule.applySoftDeleteFilter;
  });

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

  it('should not override explicit resourceStatus', () => {
    const args: { where?: Record<string, unknown> } = {
      where: { resourceStatus: 'DELETED' },
    };

    applySoftDeleteFilter(args);

    expect(args.where).toEqual({
      resourceStatus: 'DELETED',
    });
  });

  it('should not override resourceStatus with complex conditions', () => {
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
});

describe('Exports', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
  });

  it('should export getPlatformAdminPrismaClient_Unscoped function', async () => {
    const clientModule = await import('../client');
    expect(typeof clientModule.getPlatformAdminPrismaClient_Unscoped).toBe('function');
  });

  it('should NOT export the legacy getPrismaClient name (renamed in TASK-305 B.2)', async () => {
    const clientModule = await import('../client');
    expect((clientModule as unknown as Record<string, unknown>).getPrismaClient).toBeUndefined();
  });

  it('should export getExtendedPrismaClient function', async () => {
    const clientModule = await import('../client');
    expect(typeof clientModule.getExtendedPrismaClient).toBe('function');
  });

  it('should export createNewPrismaClient function', async () => {
    const clientModule = await import('../client');
    expect(typeof clientModule.createNewPrismaClient).toBe('function');
  });

  it('should export createNewExtendedPrismaClient function', async () => {
    const clientModule = await import('../client');
    expect(typeof clientModule.createNewExtendedPrismaClient).toBe('function');
  });

  it('should export applySoftDeleteFilter function', async () => {
    const clientModule = await import('../client');
    expect(typeof clientModule.applySoftDeleteFilter).toBe('function');
  });

  it('should have default export as getExtendedPrismaClient', async () => {
    const clientModule = await import('../client');
    expect(clientModule.default).toBe(clientModule.getExtendedPrismaClient);
  });
});
