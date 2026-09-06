import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';

import { Repository } from '../../../common';
import { PromptTemplateEntityMapper } from '../../../mappers';
import { PromptTemplateEntity } from '../../../entities';
import { PromptTemplate } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { PromptTemplateCategory, PromptTemplateScope, ResourceStatusType } from '../../../enums';

@Injectable()
export class PromptTemplateRepository extends Repository<PromptTemplateEntity, PromptTemplate> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'promptTemplate', PromptTemplateEntityMapper.getInstance(), undefined, ['name', 'description']);
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find prompt template by name within a tenant
   */
  async findByName(tenantId: string, name: string): Promise<PromptTemplateEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          name,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * TASK-890 §3.4 (OD-M) — ONE SYSTEM reference row by id, on the UNSCOPED base client.
   *
   * `PromptTemplate` LEAVES `SYSTEM_SHARED_READ_MODELS` (§1.5: a prompt is CONTENT), so the
   * by-id widening `PromptResolutionService` relied on to serve `SYSTEM_DEFAULTS.*` is gone.
   * Provisioning still has to READ the reference row it clones, and it is the only caller that
   * does — so the two-tenant read lives here, explicitly, exactly as
   * `WorkflowDefinitionRepository.findCloneSource` does (§2.7 #23).
   *
   * Runtime NEVER calls this: a tenant resolves its own clone through
   * {@link findByTenantAndSourceTemplateId} and gets `PROMPT_DEFAULT_NOT_PROVISIONED` on a miss.
   */
  async findSystemReferenceById(id: string, client: unknown): Promise<PromptTemplateEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors WorkflowDefinitionRepository.findCloneSource; the caller-supplied client's delegate shape isn't exposed through DomainModel typings.
    const model: any = (client as Record<string, any>)[this._modelName];
    const row: PromptTemplate | null = await model.findFirst({
      where: { id, tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.ENABLED },
    });
    return row ? PromptTemplateEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /** The whole SYSTEM reference library, on the UNSCOPED base client — the set provisioning clones. */
  async findSystemReferences(client: unknown): Promise<PromptTemplateEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findSystemReferenceById.
    const model: any = (client as Record<string, any>)[this._modelName];
    const rows: PromptTemplate[] = await model.findMany({
      where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ name: 'asc' }],
    });
    const mapper = PromptTemplateEntityMapper.getInstance();
    return (rows ?? []).map((row) => mapper.toDomainEntity(row));
  }

  /**
   * The TENANT's clone of a SYSTEM reference row, by provenance (`sourceTemplateId`).
   *
   * This is what replaces the by-id SYSTEM widening at runtime: a pointer at a platform default
   * resolves the tenant's OWN copy of it. Scoped client on purpose — the row IS the tenant's.
   * `null` on a miss (and on any lookup error) so the caller can raise the NAMED
   * `PROMPT_DEFAULT_NOT_PROVISIONED` rather than leaking a repository exception onto a
   * generation path.
   */
  async findByTenantAndSourceTemplateId(tenantId: string, sourceTemplateId: string): Promise<PromptTemplateEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, sourceTemplateId, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find all prompt templates for a department
   */
  async findByDepartment(departmentId: string): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        departmentId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all prompt templates by category
   */
  async findByCategory(category: string): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        category: category as PromptTemplateCategory,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all USER_PERSONAL templates owned by a given user inside a department, within a tenant.
   * Used by PromptManagementService.listMyPersonalForDepartment.
   */
  async findMyPersonalForDepartment(tenantId: string, ownerUserId: string, departmentId: string): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        ownerUserId,
        departmentId,
        scope: PromptTemplateScope.USER_PERSONAL,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Repository-level pagination for the admin list.
   *
   * Returns both the page slice and the total matching count in one call so
   * the controller no longer materializes the full tenant result set just to
   * slice it in memory. Mirrors the `ConsultationRepository.findPaginated*`
   * precedent (`db.findMany` + `db.count` against the same extended client, so
   * soft-delete semantics match the query-builder list path).
   */
  async findPaginated(where: Record<string, unknown>, page: number, limit: number): Promise<{ data: PromptTemplateEntity[]; count: number }> {
    const db = (this as any).db;
    const [models, count] = await Promise.all([
      db.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.count({ where }),
    ]);

    return {
      data: models.map((model: PromptTemplate) => (this as any)._mapper.toDomainEntity(model)),
      count,
    };
  }
}
