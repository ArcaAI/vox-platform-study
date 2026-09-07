/**
 * `WorkflowWebhookSecretRepository` — the ONE bootstrap lookup on the public inbound-webhook
 * route.
 *
 * Black-box J6 found `POST /api/v1/hooks/workflows/{hookId}` refusing every correctly-signed
 * delivery with the plane's uniform 404, ~1 ms in, before any signature check could run. The
 * cause is structural, not a signing bug: `WorkflowWebhookSecret` is a TENANT-SCOPED model
 * (`tenant-scope.ts`), the hook route is `@Public()` and therefore carries no tenant context,
 * so the extension THROWS `TenantScope: tenant context required` on the lookup — and the only
 * row that could establish the tenant is the one being looked up. The public handle names the
 * tenant; it cannot also be filtered by it.
 *
 * `findByHookIdUnscoped` is that lookup and nothing else: an id-only read on the UNSCOPED base
 * client, the `RbacRoleRepository.unscopedDelegate` precedent. Every tenant-facing read of this
 * model stays on the scoped client.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowWebhookSecretRepository } from '../WorkflowWebhookSecretRepository';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'hook-1',
  tenantId: 'tenant-1',
  workflowSlug: 'arcaai_api_consultation_summary',
  encryptedSecret: 'cipher',
  rotatedAt: new Date('2026-09-07T02:44:49.048Z'),
  resourceStatus: 'ENABLED',
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  version: 1,
  createdAt: new Date('2026-09-07T02:44:49.048Z'),
  updatedAt: new Date('2026-09-07T02:44:49.048Z'),
  createdBy: null,
  updatedBy: null,
  metaData: null,
  ...overrides,
});

describe('WorkflowWebhookSecretRepository.findByHookIdUnscoped', () => {
  let scopedFindFirst: ReturnType<typeof vi.fn>;
  let unscopedFindFirst: ReturnType<typeof vi.fn>;
  let repo: WorkflowWebhookSecretRepository;

  beforeEach(() => {
    scopedFindFirst = vi.fn(() => {
      throw new Error('TenantScope: tenant context required for model WorkflowWebhookSecret operation findFirst');
    });
    unscopedFindFirst = vi.fn();
    const databaseService = {
      client: { workflowWebhookSecret: { findFirst: scopedFindFirst } },
      baseClient: { workflowWebhookSecret: { findFirst: unscopedFindFirst } },
    };
    const unitOfWork = {
      getDatabaseService: () => databaseService.client,
      getCoreDatabaseService: () => databaseService,
    };
    repo = new WorkflowWebhookSecretRepository(unitOfWork as never, databaseService as never);
  });

  it('reads the row through the UNSCOPED client, so a tenant-less public route can resolve it', async () => {
    unscopedFindFirst.mockResolvedValue(row());

    const found = await repo.findByHookIdUnscoped('hook-1');

    expect(found?.tenantId).toBe('tenant-1');
    expect(found?.workflowSlug).toBe('arcaai_api_consultation_summary');
    expect(unscopedFindFirst).toHaveBeenCalledTimes(1);
    // The scoped delegate would have thrown; it must never be consulted for this one read.
    expect(scopedFindFirst).not.toHaveBeenCalled();
  });

  it('filters DELETED rows itself, since the soft-delete extension is not on the base client', async () => {
    unscopedFindFirst.mockResolvedValue(row());

    await repo.findByHookIdUnscoped('hook-1');

    const args = unscopedFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where.id).toBe('hook-1');
    expect(args.where.resourceStatus).toEqual({ not: 'DELETED' });
  });

  it('answers null for an unknown hook id rather than throwing', async () => {
    unscopedFindFirst.mockResolvedValue(null);

    await expect(repo.findByHookIdUnscoped('nope')).resolves.toBeNull();
  });
});
