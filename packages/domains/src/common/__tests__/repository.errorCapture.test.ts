/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DataConflictException,
  DataNotFoundException,
  DatabaseConnectionException,
  OptimisticConcurrencyException,
  QueryFailedException,
} from '@arcaai/exceptions';

// Same cycle-break as the sibling repository tests.
vi.mock('../databaseServices/core/core.database.module', () => ({
  CoreDatabaseModule: class {},
}));

const buildHarness = async () => {
  const { Repository } = await import('../repository');

  const db: any = {
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const uow: any = { getDatabaseService: () => ({ TestModel: db }) };
  const mapper: any = {
    toPersistence: vi.fn((e: any) => ({ ...e })),
    toPersistenceChanges: vi.fn((e: any) => e.changes ?? {}),
    toDomainEntity: vi.fn((m: any) => ({ id: m.id, version: m.version, ...m })),
  };

  class TestRepository extends (Repository as any) {
    constructor() {
      super(uow, 'TestModel', mapper);
    }
  }

  return { repo: new TestRepository() as any, db };
};

const prismaError = (code: string, message = `prisma ${code}`) => Object.assign(new Error(message), { code, name: 'PrismaClientKnownRequestError' });

describe('Repository.findFirst miss', () => {
  it('names the model and the filter keys but never the values', async () => {
    const { repo, db } = await buildHarness();
    db.findFirst.mockResolvedValue(null);

    const err: any = await repo.findFirst({ where: { email: 'patient@example.com', tenantId: 'tenant-secret' } }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DataNotFoundException);
    expect(err.message).toContain('TestModel');
    expect(err.message).toContain('email');
    expect(err.message).toContain('tenantId');
    expect(err.message).not.toContain('patient@example.com');
    expect(err.message).not.toContain('tenant-secret');
  });
});

describe('Repository.updateWithVersion error capture', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('adds tenantId to the OCC metadata when the entity has one', async () => {
    h.db.updateMany.mockResolvedValueOnce({ count: 0 });
    h.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

    const err: any = await h.repo.updateWithVersion('e-1', { tenantId: 'tenant-1', changes: { a: 1 } }, 7).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OptimisticConcurrencyException);
    expect(err.metadata).toEqual({ expectedVersion: 7, currentVersion: 9, tenantId: 'tenant-1' });
  });

  it('omits tenantId from the OCC metadata when the entity has none', async () => {
    h.db.updateMany.mockResolvedValueOnce({ count: 0 });
    h.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

    const err: any = await h.repo.updateWithVersion('e-1', { changes: { a: 1 } }, 7).catch((e: unknown) => e);

    expect(err.metadata).toEqual({ expectedVersion: 7, currentVersion: 9 });
  });

  it('wraps an unknown Prisma error from updateMany with the original as cause', async () => {
    const original = prismaError('P9999');
    h.db.updateMany.mockRejectedValueOnce(original);

    const err: any = await h.repo.updateWithVersion('e-1', { changes: { a: 1 } }, 7).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryFailedException);
    expect(err.cause).toBe(original);
  });
});

describe('Repository Prisma error mapping', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('maps P2002 to DataConflictException with cause', async () => {
    const original = prismaError('P2002');
    h.db.create.mockRejectedValueOnce(original);
    const err: any = await h.repo.create({ id: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataConflictException);
    expect(err.cause).toBe(original);
  });

  it('maps P2025 to DataNotFoundException with cause', async () => {
    const original = prismaError('P2025');
    h.db.update.mockRejectedValueOnce(original);
    const err: any = await h.repo.update('e-1', { changes: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataNotFoundException);
    expect(err.cause).toBe(original);
  });

  it.each(['P1001', 'P1002', 'P1017'])('maps %s to DatabaseConnectionException with cause', async (code) => {
    const original = prismaError(code);
    h.db.findUnique.mockRejectedValueOnce(original);
    const err: any = await h.repo.findById('e-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseConnectionException);
    expect(err.cause).toBe(original);
  });

  it('maps any other Prisma code to QueryFailedException with cause', async () => {
    const original = prismaError('P2003');
    h.db.findMany.mockRejectedValueOnce(original);
    const err: any = await h.repo.findAll({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailedException);
    expect(err.cause).toBe(original);
  });

  it('rethrows a non-Prisma error untouched', async () => {
    const original = new Error('boom');
    h.db.findMany.mockRejectedValueOnce(original);
    const err = await h.repo.findAll({}).catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it('does not re-wrap an already-domain exception', async () => {
    const original = new DataNotFoundException('TestModel', 'e-1');
    h.db.findUnique.mockRejectedValueOnce(original);
    const err = await h.repo.findById('e-1').catch((e: unknown) => e);
    expect(err).toBe(original);
  });
});

describe('Repository.findByIdOrNull', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('returns null when the row does not exist', async () => {
    h.db.findUnique.mockResolvedValueOnce(null);
    await expect(h.repo.findByIdOrNull('missing')).resolves.toBeNull();
  });

  it('returns the entity when it exists', async () => {
    h.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 1 });
    await expect(h.repo.findByIdOrNull('e-1')).resolves.toMatchObject({ id: 'e-1' });
  });

  it('rethrows anything other than DataNotFoundException', async () => {
    h.db.findUnique.mockRejectedValueOnce(prismaError('P1001'));
    await expect(h.repo.findByIdOrNull('e-1')).rejects.toBeInstanceOf(DatabaseConnectionException);
  });
});
