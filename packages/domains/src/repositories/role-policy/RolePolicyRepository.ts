/**
 * `RolePolicyRepository` is the thin facade that
 * encapsulates `databaseService.client.rolePolicy.*` for
 * `RbacRoleService.assignPolicy` / `.removePolicy`.
 *
 * Surface design:
 *
 *   • `findFirstByRoleAndPolicy(roleId, policyId)` — the assign-path
 *     existence pre-check; intentionally does NOT filter by
 *     `resourceStatus` so the service can re-enable a soft-deleted
 *     row (legacy behaviour).
 *   • `create(data)` — accepts the factory-built input.
 *   • `reEnable(id, data)` — accepts the factory's re-enable shape;
 *     uses Prisma `update` by id.
 *   • `softDeleteByRoleAndPolicy(roleId, policyId, updatedBy?)` —
 *     uses Prisma `updateMany` (matching the legacy verbatim) so
 *     the service doesn't have to look up the surrogate `id`. This
 *     routes the audit-stamp pattern through the
 *     repository, not the service.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CoreDatabaseService } from '../../common/databaseServices/core/core.database.service';
import { ResourceStatusType } from '../../enums';
import type { RolePolicyCreateInputShape, RolePolicyReEnableInputShape } from './RolePolicyFactory';

interface RolePolicyDelegateLike {
  findFirst: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
}

@Injectable()
export class RolePolicyRepository {
  constructor(@Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService) {}

  private get delegate(): RolePolicyDelegateLike {
    return (this.databaseService.client as unknown as { rolePolicy: RolePolicyDelegateLike }).rolePolicy;
  }

  async findFirstByRoleAndPolicy(roleId: string, policyId: string): Promise<unknown> {
    return this.delegate.findFirst({ where: { roleId, policyId } });
  }

  async create(data: RolePolicyCreateInputShape): Promise<unknown> {
    return this.delegate.create({ data });
  }

  async reEnable(id: string, data: RolePolicyReEnableInputShape): Promise<unknown> {
    return this.delegate.update({ where: { id }, data });
  }

  async softDeleteByRoleAndPolicy(roleId: string, policyId: string, updatedBy?: string): Promise<unknown> {
    return this.delegate.updateMany({
      where: { roleId, policyId },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      },
    });
  }

  /**
   * Number of ENABLED role assignments carrying this policy.
   * `PolicyService` uses it to decide whether a rule-edit needs break-glass
   * (a policy attached to >1 role has a multi-role blast radius).
   */
  async countEnabledByPolicy(policyId: string): Promise<number> {
    return this.delegate.count({
      where: { policyId, resourceStatus: ResourceStatusType.ENABLED },
    });
  }
}
