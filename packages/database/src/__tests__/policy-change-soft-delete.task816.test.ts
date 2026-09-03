/**
 * / D-24 — the two policy WORM change logs are soft-delete exempt.
 *
 * `HarnessPolicyChange` and `PipelinePolicyChange` are identity-only, append-only WORM tables:
 * their Prisma models declare "Identity only — NO `_version` / `_metadata` / `updatedAt` /
 * `resourceStatus`", and the migration that introduces each one `REVOKE`s UPDATE and DELETE from
 * the application role. That is the SAME shape as `WorkflowAssignmentChange` and
 * `HarnessAuditEvent`, both of which are listed in `MODELS_WITHOUT_SOFT_DELETE`. These two were
 * not.
 *
 * ## The failure mode, and why it was dormant rather than absent
 *
 * `applySoftDeleteExtension` injects `resourceStatus: { not: 'DELETED' }` into `findMany` /
 * `findFirst` / `count` / `aggregate` / `groupBy` for every model NOT in that set. Against a table
 * with no such column Prisma raises `PrismaClientValidationError` — the exact failure `client.ts`'s
 * own `AsrPipelineVersion` comment records ("Prisma rejected it ... bare 400 on GET").
 *
 * It has never fired because the one gated caller, `HarnessPolicyChangeRepository.listForTenant` /
 * `PipelinePolicyChangeRepository.listForTenant`, has no invocation anywhere yet, and the WRITES
 * (`.create()`) are not a filtered operation. So this is a trap armed for the first engineer who
 * surfaces a policy change log — which, for two tables whose whole purpose is an auditable change
 * trail, is a matter of when.
 */

import { describe, expect, it, vi } from 'vitest';

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

import { applySoftDeleteFilter, MODELS_WITHOUT_SOFT_DELETE, modelHasSoftDelete } from '../client';

const WORM_CHANGE_LOGS = ['HarnessPolicyChange', 'PipelinePolicyChange'] as const;
const FILTERED_OPERATIONS = ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy'] as const;

/** Mirrors the real extension handler in `client.ts` (same shape the sibling suite simulates). */
function simulateExtensionHandler(operation: string, model: string, args: { where?: Record<string, unknown> }): void {
  if (operation !== 'findUnique' && modelHasSoftDelete(model)) {
    applySoftDeleteFilter(args);
  }
}

describe('D-24 — the policy WORM change logs are exempt from soft-delete filtering', () => {
  it.each(WORM_CHANGE_LOGS)('%s is listed in MODELS_WITHOUT_SOFT_DELETE', (model) => {
    expect(MODELS_WITHOUT_SOFT_DELETE.has(model)).toBe(true);
  });

  it.each(WORM_CHANGE_LOGS)('modelHasSoftDelete("%s") is false in both casings', (model) => {
    const camel = model.charAt(0).toLowerCase() + model.slice(1);
    expect(modelHasSoftDelete(model)).toBe(false);
    expect(modelHasSoftDelete(camel)).toBe(false);
  });

  describe('no filtered operation injects a `resourceStatus` these tables do not have', () => {
    WORM_CHANGE_LOGS.forEach((model) => {
      FILTERED_OPERATIONS.forEach((op) => {
        it(`${model}.${op} leaves the where clause untouched`, () => {
          const args = { where: { tenantId: 'tenant-1' } };
          simulateExtensionHandler(op, model, args);
          expect(args.where).toEqual({ tenantId: 'tenant-1' });
          expect(args.where.resourceStatus).toBeUndefined();
        });
      });
    });
  });

  it('matches the posture already granted to the sibling WORM logs', () => {
    // The precedent, not a new policy: same identity-only shape, same REVOKE, same exemption.
    expect(MODELS_WITHOUT_SOFT_DELETE.has('WorkflowAssignmentChange')).toBe(true);
    expect(MODELS_WITHOUT_SOFT_DELETE.has('HarnessAuditEvent')).toBe(true);
  });
});
