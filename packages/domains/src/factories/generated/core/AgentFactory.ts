/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { AgentEntity, IAgentEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAgentProps extends BaseEntityFactoryCreateProps {
  tenantId: IAgentEntity['tenantId'];
  slug: IAgentEntity['slug'];
  name: IAgentEntity['name'];
  description?: IAgentEntity['description'];
  task: IAgentEntity['task'];
  versionNumber: IAgentEntity['versionNumber'];
  parentVersionId?: IAgentEntity['parentVersionId'];
  status?: IAgentEntity['status'];
  isActive?: IAgentEntity['isActive'];
  modelId: IAgentEntity['modelId'];
  instruction?: IAgentEntity['instruction'];
  parameters?: IAgentEntity['parameters'];
  inputSchema?: IAgentEntity['inputSchema'];
  outputSchema?: IAgentEntity['outputSchema'];
  tools?: IAgentEntity['tools'];
  compiledConfig?: IAgentEntity['compiledConfig'];
  compiledConfigChecksum?: IAgentEntity['compiledConfigChecksum'];
  validationReport?: IAgentEntity['validationReport'];
  validatedAt?: IAgentEntity['validatedAt'];
  publishedAt?: IAgentEntity['publishedAt'];
  deprecatedAt?: IAgentEntity['deprecatedAt'];
  tags?: IAgentEntity['tags'];
  Tenant?: IAgentEntity['Tenant'];

  createdAt?: IAgentEntity['createdAt'];
  createdBy?: IAgentEntity['createdBy'];
}

export class AgentFactory {
  /**
   * Build one agent-version row. `id` is a time-sortable UUIDv7; `status`
   * defaults to DRAFT; `isActive` to `false`; every server-owned column
   * (`compiledConfig`, `publishedAt`, ...) defaults to null until publish.
   */
  static CreateAgent(props: CreateAgentProps): AgentEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AgentEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      slug: props.slug,
      name: props.name,
      description: props.description ?? null,
      task: props.task,
      versionNumber: props.versionNumber,
      parentVersionId: props.parentVersionId ?? null,
      status: props.status ?? Enums.WorkflowDefinitionStatus.DRAFT,
      isActive: props.isActive ?? false,
      modelId: props.modelId,
      instruction: props.instruction ?? null,
      parameters: props.parameters ?? null,
      inputSchema: props.inputSchema ?? null,
      outputSchema: props.outputSchema ?? null,
      tools: props.tools ?? null,
      compiledConfig: props.compiledConfig ?? null,
      compiledConfigChecksum: props.compiledConfigChecksum ?? null,
      validationReport: props.validationReport ?? null,
      validatedAt: props.validatedAt ?? null,
      publishedAt: props.publishedAt ?? null,
      deprecatedAt: props.deprecatedAt ?? null,
      tags: props.tags ?? [],
      resourceStatus: props.resourceStatus,
      resourceStatusUpdatedAt: props.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: props.resourceStatusUpdatedBy,
      Tenant: props.Tenant ?? null,
    });
  }
}
