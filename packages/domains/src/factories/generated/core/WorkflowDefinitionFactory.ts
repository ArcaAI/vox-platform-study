/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { WorkflowDefinitionEntity, IWorkflowDefinitionEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateWorkflowDefinitionProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowDefinitionEntity['tenantId'];
  slug: IWorkflowDefinitionEntity['slug'];
  name: IWorkflowDefinitionEntity['name'];
  description?: IWorkflowDefinitionEntity['description'];
  paletteKey: IWorkflowDefinitionEntity['paletteKey'];
  versionNumber: IWorkflowDefinitionEntity['versionNumber'];
  parentVersionId?: IWorkflowDefinitionEntity['parentVersionId'];
  status?: IWorkflowDefinitionEntity['status'];
  graph: IWorkflowDefinitionEntity['graph'];
  graphChecksum: IWorkflowDefinitionEntity['graphChecksum'];
  compiledConfig?: IWorkflowDefinitionEntity['compiledConfig'];
  compiledConfigChecksum?: IWorkflowDefinitionEntity['compiledConfigChecksum'];
  registryChecksum?: IWorkflowDefinitionEntity['registryChecksum'];
  validationReport?: IWorkflowDefinitionEntity['validationReport'];
  needsReview?: IWorkflowDefinitionEntity['needsReview'];
  validatedAt?: IWorkflowDefinitionEntity['validatedAt'];
  publishedAt?: IWorkflowDefinitionEntity['publishedAt'];
  deprecatedAt?: IWorkflowDefinitionEntity['deprecatedAt'];
  isActive?: IWorkflowDefinitionEntity['isActive'];
  tags?: IWorkflowDefinitionEntity['tags'];
  Tenant?: IWorkflowDefinitionEntity['Tenant'];

  createdAt?: IWorkflowDefinitionEntity['createdAt'];
  createdBy?: IWorkflowDefinitionEntity['createdBy'];
}

export class WorkflowDefinitionFactory {
  /**
   * Build one definition-version row. `id` is a time-sortable UUIDv7;
   * `status` defaults to DRAFT (a new row is always authored as a draft —
   * TASK-716/719's validate/publish flows advance it). `isActive`/`needsReview`
   * default to `false`; every other server-owned column (`compiledConfig`,
   * `publishedAt`, ...) defaults to null/unset until the publish step sets it.
   */
  static CreateDefinition(props: CreateWorkflowDefinitionProps): WorkflowDefinitionEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new WorkflowDefinitionEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      slug: props.slug,
      name: props.name,
      description: props.description ?? null,
      paletteKey: props.paletteKey,
      versionNumber: props.versionNumber,
      parentVersionId: props.parentVersionId ?? null,
      status: props.status ?? Enums.WorkflowDefinitionStatus.DRAFT,
      graph: props.graph,
      graphChecksum: props.graphChecksum,
      compiledConfig: props.compiledConfig ?? null,
      compiledConfigChecksum: props.compiledConfigChecksum ?? null,
      registryChecksum: props.registryChecksum ?? null,
      validationReport: props.validationReport ?? null,
      needsReview: props.needsReview ?? false,
      validatedAt: props.validatedAt ?? null,
      publishedAt: props.publishedAt ?? null,
      deprecatedAt: props.deprecatedAt ?? null,
      isActive: props.isActive ?? false,
      tags: props.tags ?? [],
      resourceStatus: props.resourceStatus,
      resourceStatusUpdatedAt: props.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: props.resourceStatusUpdatedBy,
      Tenant: props.Tenant ?? null,
    });
  }
}
