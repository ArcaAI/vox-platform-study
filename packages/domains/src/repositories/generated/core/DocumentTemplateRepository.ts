import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { DocumentTemplateEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { DocumentTemplateEntityMapper } from '../../../mappers';
import { DocumentTemplate } from '../../../models';

/**
 * The MUTABLE head of a tenant's clinical-document SHAPE catalog (TASK-810).
 *
 * Ordinary tenant-scoped model (the Prisma tenant-scope extension pins
 * `tenantId` on every query; `DocumentTemplate` is in `TENANT_SCOPED_MODELS`
 * and deliberately NOT in `SYSTEM_SHARED_READ_MODELS`). Standard soft-delete
 * lifecycle.
 *
 * The two finders below are the RESOLUTION primitives a generation node uses:
 * by slug when its config names one, otherwise the tenant default. The cascade
 * itself is assembled in `DocumentTemplateService`, not here — one repository
 * call per tier, mirroring `ConsultationContextSchemaRepository`.
 */
@Injectable()
export class DocumentTemplateRepository extends Repository<DocumentTemplateEntity, DocumentTemplate> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'documentTemplate', DocumentTemplateEntityMapper.getInstance());
  }

  /** The ENABLED row owned exactly by `(tenantId, slug)`, or null. */
  async findByTenantAndSlug(tenantId: string, slug: string): Promise<DocumentTemplateEntity | null> {
    return this.findFirstTolerant({ tenantId, slug, resourceStatus: ResourceStatusType.ENABLED });
  }

  /** The tenant's default template — what a generation node resolves when its config names none. */
  async findDefaultForTenant(tenantId: string): Promise<DocumentTemplateEntity | null> {
    return this.findFirstTolerant({ tenantId, isDefault: true, resourceStatus: ResourceStatusType.ENABLED });
  }

  /**
   * `findFirst` throws `DataNotFoundException` on a miss. Only a genuine miss
   * maps to null — anything else (most importantly the tenant-scope
   * extension's cross-tenant throw) must SURFACE, or a super-admin read
   * targeting a foreign tenant would silently "succeed" as empty. Same
   * treatment as `ConsultationContextSchemaRepository`.
   */
  private async findFirstTolerant(filters: Record<string, unknown>): Promise<DocumentTemplateEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<DocumentTemplate> would require importing the Prisma-generated model type here.
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
