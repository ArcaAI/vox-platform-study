/**
 * CoreDatabaseService Unit Tests
 *
 * Tests for the CoreDatabaseService that provides database access
 * with soft-delete filtering via the extended Prisma client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the @arcaai/database module
const mockPrismaClient = {
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $queryRawUnsafe: vi.fn(),
  $queryRaw: vi.fn(),
};

const mockExtendedPrismaClient = {
  ...mockPrismaClient,
  // Extended client has soft-delete filtering
};

vi.mock('@arcaai/database', () => ({
  getPrismaClient: vi.fn(() => mockPrismaClient),
  getExtendedPrismaClient: vi.fn(() => mockExtendedPrismaClient),
}));

// Import after mocking
import { CoreDatabaseService } from '../core.database.service';

describe('CoreDatabaseService', () => {
  let service: CoreDatabaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CoreDatabaseService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service instance', () => {
      expect(service).toBeDefined();
    });

    it('should use shared Prisma client from @arcaai/database', async () => {
      const { getPrismaClient, getExtendedPrismaClient } = await import('@arcaai/database');

      // Creating a new service should use the shared clients
      new CoreDatabaseService();

      expect(getPrismaClient).toHaveBeenCalled();
      expect(getExtendedPrismaClient).toHaveBeenCalled();
    });
  });

  describe('client getter', () => {
    it('should return extended Prisma client with soft-delete filtering', () => {
      const client = service.client;

      expect(client).toBe(mockExtendedPrismaClient);
    });

    it('should return same client instance on multiple calls', () => {
      const client1 = service.client;
      const client2 = service.client;

      expect(client1).toBe(client2);
    });
  });

  describe('baseClient getter', () => {
    it('should return base Prisma client without soft-delete filtering', () => {
      const baseClient = service.baseClient;

      expect(baseClient).toBe(mockPrismaClient);
    });

    it('should return same baseClient instance on multiple calls', () => {
      const baseClient1 = service.baseClient;
      const baseClient2 = service.baseClient;

      expect(baseClient1).toBe(baseClient2);
    });
  });

  describe('query method', () => {
    it('should execute raw SQL query', async () => {
      const expectedResult = [{ id: '1', name: 'test' }];
      mockPrismaClient.$queryRawUnsafe.mockResolvedValue(expectedResult);

      const result = await service.query('SELECT * FROM users');

      expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalledWith('SELECT * FROM users');
      expect(result).toEqual(expectedResult);
    });

    it('should handle query errors', async () => {
      const error = new Error('Query failed');
      mockPrismaClient.$queryRawUnsafe.mockRejectedValue(error);

      await expect(service.query('INVALID SQL')).rejects.toThrow('Query failed');
    });
  });

  describe('queryRaw method', () => {
    it('should execute parameterized raw SQL query', async () => {
      const expectedResult = [{ id: '1' }];
      mockPrismaClient.$queryRaw.mockResolvedValue(expectedResult);

      const result = await service.queryRaw`SELECT * FROM users WHERE id = ${'user-1'}`;

      expect(mockPrismaClient.$queryRaw).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });
  });

  describe('onModuleInit lifecycle', () => {
    it('should connect to database on module init', async () => {
      await service.onModuleInit();

      expect(mockPrismaClient.$connect).toHaveBeenCalled();
    });

    it('should throw error if connection fails', async () => {
      const connectionError = new Error('Connection failed');
      mockPrismaClient.$connect.mockRejectedValueOnce(connectionError);

      await expect(service.onModuleInit()).rejects.toThrow('Connection failed');
    });
  });

  describe('onModuleDestroy lifecycle', () => {
    it('should disconnect from database on module destroy', async () => {
      await service.onModuleDestroy();

      expect(mockPrismaClient.$disconnect).toHaveBeenCalled();
    });
  });

  describe('client differentiation', () => {
    it('should provide two different client instances for different use cases', () => {
      // The service provides two clients:
      // - client: Extended client with soft-delete filtering (for normal operations)
      // - baseClient: Raw Prisma client (for admin operations like restore)
      const extendedClient = service.client;
      const rawClient = service.baseClient;

      // Verify they are different instances
      expect(extendedClient).not.toBe(rawClient);

      // Verify each returns the correct mock
      expect(extendedClient).toBe(mockExtendedPrismaClient);
      expect(rawClient).toBe(mockPrismaClient);
    });
  });
});

describe('CoreDatabaseService — Vault-backed prisma factory (Phase 5 Task 5.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the injected VAULT_PRISMA_FACTORY when present and skips the static getPrismaClient', async () => {
    const vaultPrisma = {
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $queryRawUnsafe: vi.fn(),
      $queryRaw: vi.fn(),
    };
    const vaultExtended = { ...vaultPrisma };
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const vaultFactory = vi.fn(async () => ({
      client: vaultPrisma,
      extendedClient: vaultExtended,
      disconnect,
    }));

    const { CoreDatabaseService } = await import('../core.database.service');
    const svc = new CoreDatabaseService(vaultFactory as never);
    await svc.onModuleInit();

    expect(vaultFactory).toHaveBeenCalledTimes(1);
    expect(svc.baseClient).toBe(vaultPrisma);
    expect(svc.client).toBe(vaultExtended);
    expect(vaultPrisma.$connect).not.toHaveBeenCalled();
  });

  it('calls the factory-provided disconnect on module destroy (Vault mode)', async () => {
    const vaultPrisma = {
      $connect: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $queryRawUnsafe: vi.fn(),
      $queryRaw: vi.fn(),
    };
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const vaultFactory = vi.fn(async () => ({
      client: vaultPrisma,
      extendedClient: { ...vaultPrisma },
      disconnect,
    }));

    const { CoreDatabaseService } = await import('../core.database.service');
    const svc = new CoreDatabaseService(vaultFactory as never);
    await svc.onModuleInit();
    await svc.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vaultPrisma.$disconnect).not.toHaveBeenCalled();
  });

  it('falls back to the env-mode singletons when no VAULT_PRISMA_FACTORY is injected', async () => {
    const { CoreDatabaseService } = await import('../core.database.service');
    const svc = new CoreDatabaseService();
    await svc.onModuleInit();

    expect(svc.baseClient).toBe(mockPrismaClient);
    expect(svc.client).toBe(mockExtendedPrismaClient);
    expect(mockPrismaClient.$connect).toHaveBeenCalled();
  });

  it('does not require the env DATABASE_URL when the Vault factory is wired', async () => {
    const vaultPrisma = {
      $connect: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $queryRawUnsafe: vi.fn(),
      $queryRaw: vi.fn(),
    };
    const vaultFactory = vi.fn(async () => ({
      client: vaultPrisma,
      extendedClient: { ...vaultPrisma },
      disconnect: vi.fn().mockResolvedValue(undefined),
    }));

    const { getPrismaClient, getExtendedPrismaClient } = await import('@arcaai/database');

    const { CoreDatabaseService } = await import('../core.database.service');
    const svc = new CoreDatabaseService(vaultFactory as never);
    await svc.onModuleInit();

    expect(getPrismaClient).not.toHaveBeenCalled();
    expect(getExtendedPrismaClient).not.toHaveBeenCalled();
  });
});

/**
 * Note: Soft-delete filtering behavior is tested in integration tests at:
 * packages/domains/src/integration/repository-soft-delete.integration.test.ts
 *
 * Those tests verify actual database behavior with real PostgreSQL.
 * Unit tests here focus on the CoreDatabaseService class behavior.
 */
