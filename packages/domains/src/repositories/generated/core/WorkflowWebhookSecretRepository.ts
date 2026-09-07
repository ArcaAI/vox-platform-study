import { Inject, Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreDatabaseService } from '../../../common/databaseServices/core/core.database.service';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowWebhookSecretEntity } from '../../../entities';
import { WorkflowWebhookSecretEntityMapper } from '../../../mappers';
import { WorkflowWebhookSecret } from '../../../models';

/**
 * TASK-864 — the inbound workflow webhook trigger's per-definition secret.
 *
 * HAND-AUTHORED (the `gen:repository` generator is broken — rule 03), following the
 * `AiProviderConnectionRepository` precedent. One row per (tenant, workflowSlug), enforced by
 * `WorkflowWebhookSecret_tenant_slug_key`. Tenant-scoped through the Prisma extension; never
 * SYSTEM-shared.
 */
@Injectable()
export class WorkflowWebhookSecretRepository extends Repository<WorkflowWebhookSecretEntity, WorkflowWebhookSecret> {
  constructor(
    private readonly unitOfWorkService: CoreUnitOfWorkService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(unitOfWorkService, 'workflowWebhookSecret', WorkflowWebhookSecretEntityMapper.getInstance());
  }

  /**
   * The hook id -> secret row lookup that the PUBLIC inbound-webhook route
   * (`POST /api/v1/hooks/workflows/{hookId}`) makes before anything about the caller is known.
   *
   * It reads the UNSCOPED base client on purpose, and it is the only method here that does.
   * `WorkflowWebhookSecret` is tenant-scoped (`tenant-scope.ts`), and that route is `@Public()`
   * — no session, no API key, no CLS tenant — so the scoped client THROWS
   * `TenantScope: tenant context required` before the signature can be checked, which the
   * exposure service could only report as its uniform 404. The row's own `tenantId` is the
   * ANSWER this lookup produces (the caller adopts it), so it cannot also be the filter.
   * Precedent for reaching past the extension from a repository: `RbacRoleRepository`'s
   * `unscopedDelegate`.
   *
   * Two safety properties keep this narrow: the read is by PRIMARY KEY only (an unguessable
   * UUIDv7 that is itself the public handle), and it returns the row for the caller to verify
   * an HMAC against — possession of the secret, not this lookup, is what authenticates.
   * Soft-delete is filtered here because the base client carries neither extension.
   */
  async findByHookIdUnscoped(hookId: string): Promise<WorkflowWebhookSecretEntity | null> {
    const delegate = (this.databaseService.baseClient as unknown as Record<string, { findFirst: (args: unknown) => Promise<unknown> }>)
      .workflowWebhookSecret;
    const model = (await delegate.findFirst({
      where: { id: hookId, resourceStatus: { not: 'DELETED' } },
    })) as WorkflowWebhookSecret | null;
    return model === null ? null : WorkflowWebhookSecretEntityMapper.getInstance().toDomainEntity(model);
  }

  /** The ONE secret row of a workflow lineage, or `null` when none was ever issued. */
  async findByTenantSlug(tenantId: string, workflowSlug: string): Promise<WorkflowWebhookSecretEntity | null> {
    const rows = await this.findAll({ filters: { tenantId, workflowSlug } });
    return rows[0] ?? null;
  }
}
