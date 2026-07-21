/**
 * Soft-Delete Extension `findUnique` Handler Tests
 *
 * Pins the contract that the soft-delete Prisma extension's `findUnique`
 * handler applies the `resourceStatus` filter on soft-deletable models, in
 * line with the documented behaviour and the other filtered operations
 * (`findFirst`, `findMany`, `count`, `aggregate`, `groupBy`).
 *
 * Previously the `findUnique` handler bypassed
 * `applySoftDeleteFilter`, so `findUnique({ where: { id } })` returned rows
 * even when `resourceStatus = 'DELETED'`. See
 * `docs/multi-tenancy-audit/02-prisma-schema-review.md`.
 *
 * Unlike `soft-delete-extension.test.ts` (which exercises the pure helpers
 * via a hand-rolled simulator), this file invokes the REAL handler returned
 * by `applySoftDeleteExtension` so any future drift is caught here.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $extends: vi.fn().mockReturnThis(),
  })),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    PrismaClientUnknownRequestError: class extends Error {},
    PrismaClientRustPanicError: class extends Error {},
    PrismaClientInitializationError: class extends Error {},
    PrismaClientValidationError: class extends Error {},
  },
}));

vi.mock('../env.js', () => ({}));

import { applySoftDeleteExtension, MODELS_WITHOUT_SOFT_DELETE } from '../client';

type FindUniqueHandler = (params: {
  model: string;
  args: { where?: Record<string, unknown> };
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

/**
 * Captures the `$extends` config that `applySoftDeleteExtension` builds and
 * returns the production `findUnique` handler so tests can invoke it directly.
 */
function getFindUniqueHandler(): FindUniqueHandler {
  let captured: any = null;
  const fakePrisma: any = {
    $extends: vi.fn().mockImplementation((config: any) => {
      captured = config;
      return fakePrisma;
    }),
  };

  applySoftDeleteExtension(fakePrisma);

  expect(captured).not.toBeNull();
  expect(typeof captured.query.$allModels.findUnique).toBe('function');
  return captured.query.$allModels.findUnique;
}

describe('softDeleteFilter extension — findUnique handler (TASK-305 B.12)', () => {
  it('auto-injects `resourceStatus: { not: "DELETED" }` on a soft-deletable model', async () => {
    const findUnique = getFindUniqueHandler();
    const args = { where: { id: 'dept-123' } };
    const query = vi.fn().mockResolvedValue(null);

    await findUnique({ model: 'Department', args, query });

    expect(args.where).toEqual({
      id: 'dept-123',
      resourceStatus: { not: 'DELETED' },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(args);
  });

  it('does NOT inject the filter for models in MODELS_WITHOUT_SOFT_DELETE', async () => {
    const findUnique = getFindUniqueHandler();

    for (const model of MODELS_WITHOUT_SOFT_DELETE) {
      const args = { where: { id: `${model}-id` } };
      const query = vi.fn().mockResolvedValue(null);

      await findUnique({ model, args, query });

      expect(args.where, `injected filter for ${model}`).toEqual({
        id: `${model}-id`,
      });
      expect(query).toHaveBeenCalledWith(args);
    }
  });

  it("preserves the caller's explicit resourceStatus filter (does not overwrite)", async () => {
    const findUnique = getFindUniqueHandler();
    const args = {
      where: { id: 'cons-1', resourceStatus: 'DELETED' as const },
    };
    const query = vi.fn().mockResolvedValue(null);

    await findUnique({ model: 'Consultation', args, query });

    expect(args.where.resourceStatus).toBe('DELETED');
    expect(args.where).toEqual({ id: 'cons-1', resourceStatus: 'DELETED' });
    expect(query).toHaveBeenCalledWith(args);
  });
});
