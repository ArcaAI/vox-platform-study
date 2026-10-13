/**
 * Soft-Delete Extension — the other read handlers (TASK-1067)
 *
 * `client.softDelete.findUnique.test.ts` pins `findUnique`; this file pins the
 * remaining read operations on the REAL handlers `applySoftDeleteExtension`
 * builds. `count`, `aggregate` and `groupBy` matter as much as the finders: a
 * handler that dropped the filter would leak deleted rows into totals and
 * dashboards without any row ever being returned.
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

type ReadHandler = (params: {
  model: string;
  args: { where?: Record<string, unknown> };
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

const READ_OPS = ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy'] as const;

function getHandler(op: (typeof READ_OPS)[number]): ReadHandler {
  let captured: any = null;
  const fakePrisma: any = {
    $extends: vi.fn().mockImplementation((config: any) => {
      captured = config;
      return fakePrisma;
    }),
  };
  applySoftDeleteExtension(fakePrisma);
  expect(typeof captured?.query.$allModels[op]).toBe('function');
  return captured.query.$allModels[op];
}

describe.each(READ_OPS)('softDeleteFilter extension — %s handler', (op) => {
  it('injects `resourceStatus: { not: "DELETED" }` on a soft-deletable model', async () => {
    const handler = getHandler(op);
    const args = { where: { tenantId: 't-1' } };
    const query = vi.fn().mockResolvedValue([]);

    await handler({ model: 'Department', args, query });

    expect(args.where).toEqual({ tenantId: 't-1', resourceStatus: { not: 'DELETED' } });
    expect(query).toHaveBeenCalledWith(args);
  });

  it('adds the filter when the caller passed no `where` at all', async () => {
    const handler = getHandler(op);
    const args: { where?: Record<string, unknown> } = {};
    const query = vi.fn().mockResolvedValue([]);

    await handler({ model: 'Consultation', args, query });

    expect(args.where).toEqual({ resourceStatus: { not: 'DELETED' } });
  });

  it('leaves models in MODELS_WITHOUT_SOFT_DELETE untouched', async () => {
    const handler = getHandler(op);
    for (const model of MODELS_WITHOUT_SOFT_DELETE) {
      const args = { where: { id: `${model}-id` } };
      const query = vi.fn().mockResolvedValue([]);

      await handler({ model, args, query });

      expect(args.where, `filter injected for ${model}`).toEqual({ id: `${model}-id` });
      expect(query).toHaveBeenCalledWith(args);
    }
  });

  it("keeps the caller's explicit resourceStatus (an admin view of deleted rows)", async () => {
    const handler = getHandler(op);
    const args = { where: { resourceStatus: 'DELETED' as const } };
    const query = vi.fn().mockResolvedValue([]);

    await handler({ model: 'Consultation', args, query });

    expect(args.where).toEqual({ resourceStatus: 'DELETED' });
  });

  it("returns the query's own result", async () => {
    const handler = getHandler(op);
    const result = { _count: 3 };

    await expect(handler({ model: 'Department', args: {}, query: vi.fn().mockResolvedValue(result) })).resolves.toBe(result);
  });
});
