import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsultationContextSchemaEntity } from '../../../entities';
import { ConsultationContextSchemaScope, ResourceStatusType } from '../../../enums';
import { ConsultationContextSchemaEntityMapper } from '../../../mappers';
import { ConsultationContextSchema } from '../../../models';

/**
 * The MUTABLE head of a tenant's consultation context declaration.
 *
 * Ordinary tenant-scoped model (the Prisma tenant-scope extension pins
 * `tenantId` on every query; `ConsultationContextSchema` is in
 * `TENANT_SCOPED_MODELS` and deliberately NOT in `SYSTEM_SHARED_READ_MODELS`).
 * Standard soft-delete lifecycle.
 *
 * The two finders below are the DISCOVERY resolution primitives: a
 * DEPARTMENT-scoped default wins over the TENANT-scoped default for the same
 * tenant. The cascade itself (department → tenant → none) is assembled in
 * `ConsultationContextSchemaService`, not here — one repository call per tier,
 * mirroring `AiTaskDefaultRepository.findByTenantAndTaskKey`.
 */
@Injectable()
export class ConsultationContextSchemaRepository extends Repository<ConsultationContextSchemaEntity, ConsultationContextSchema> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationContextSchema', ConsultationContextSchemaEntityMapper.getInstance());
  }

  /** The ENABLED row owned exactly by `(tenantId, slug)`, or null. */
  async findByTenantAndSlug(tenantId: string, slug: string): Promise<ConsultationContextSchemaEntity | null> {
    return this.findFirstTolerant({ tenantId, slug, resourceStatus: ResourceStatusType.ENABLED });
  }

  /**
   * The tenant's default schema for a scope. `departmentId` is required for
   * `DEPARTMENT` and must be absent for `TENANT` — passing the wrong pair
   * simply matches nothing rather than silently widening the read.
   */
  async findDefaultForScope(
    tenantId: string,
    scope: ConsultationContextSchemaScope,
    departmentId?: string | null,
  ): Promise<ConsultationContextSchemaEntity | null> {
    return this.findFirstTolerant({
      tenantId,
      scope,
      departmentId: scope === ConsultationContextSchemaScope.DEPARTMENT ? departmentId : null,
      isDefault: true,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  }

  /**
   * `findFirst` throws `DataNotFoundException` on a miss. Only a genuine miss
   * maps to null — anything else (most importantly the tenant-scope
   * extension's cross-tenant throw) must SURFACE, or a super-admin read
   * targeting a foreign tenant would silently "succeed" as empty. Same
   * treatment as `AiTaskDefaultRepository.findByTenantAndTaskKey`.
   */
  private async findFirstTolerant(filters: Record<string, unknown>): Promise<ConsultationContextSchemaEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<ConsultationContextSchema> would require importing the Prisma-generated model type here.
      const result = await this.findFirst({ filters: filters as any });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
