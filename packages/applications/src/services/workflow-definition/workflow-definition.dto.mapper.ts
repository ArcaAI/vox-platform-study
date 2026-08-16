import { WorkflowDefinitionEntity } from '@arcaai/domains';
import type { WorkflowNodeDescriptor } from '@arcaai/workflow-contract';
import { FetchResponse } from '../../common';
import { PaginatedWorkflowDefinitionResponse, WorkflowDefinitionResponse, WorkflowNodeResponse } from './dto';

export class WorkflowDefinitionDtoMapper {
  static toResponse(entity: WorkflowDefinitionEntity): WorkflowDefinitionResponse {
    const dto = new WorkflowDefinitionResponse();
    dto.id = entity.id;
    dto.tenantId = entity.tenantId;
    dto.slug = entity.slug;
    dto.name = entity.name;
    dto.description = entity.description ?? null;
    dto.paletteKey = entity.paletteKey;
    dto.versionNumber = entity.versionNumber;
    dto.parentVersionId = entity.parentVersionId ?? null;
    dto.status = String(entity.status);
    dto.graph = entity.graph as Record<string, unknown>;
    dto.graphChecksum = entity.graphChecksum;
    dto.compiledConfig = (entity.compiledConfig as Record<string, unknown> | null) ?? null;
    dto.compiledConfigChecksum = entity.compiledConfigChecksum ?? null;
    dto.registryChecksum = entity.registryChecksum ?? null;
    dto.validationReport = (entity.validationReport as Record<string, unknown> | null) ?? null;
    dto.needsReview = entity.needsReview;
    dto.validatedAt = entity.validatedAt ? entity.validatedAt.toISOString() : null;
    dto.publishedAt = entity.publishedAt ? entity.publishedAt.toISOString() : null;
    dto.deprecatedAt = entity.deprecatedAt ? entity.deprecatedAt.toISOString() : null;
    dto.isActive = entity.isActive;
    dto.resourceStatus = String(entity.resourceStatus);
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    dto.version = entity.version;
    dto.tags = entity.tags ?? [];
    return dto;
  }

  static toPaginatedResponse({ page, limit, count, data }: FetchResponse<WorkflowDefinitionEntity>): PaginatedWorkflowDefinitionResponse {
    return new PaginatedWorkflowDefinitionResponse({
      page,
      limit,
      count,
      data: data.map((entity) => this.toResponse(entity)),
    });
  }

  static toNodeResponse(descriptor: WorkflowNodeDescriptor): WorkflowNodeResponse {
    const dto = new WorkflowNodeResponse();
    dto.type = descriptor.key;
    dto.implemented = descriptor.implemented;
    dto.activityName = descriptor.activityName;
    dto.classes = [...descriptor.classes];
    dto.paletteKey = descriptor.paletteKey;
    dto.critical = descriptor.critical;
    dto.externalWrite = descriptor.externalWrite;
    dto.defaultTimeoutSeconds = descriptor.defaultTimeoutSeconds;
    dto.defaultMaxAttempts = descriptor.defaultMaxAttempts;
    dto.entitlementKey = descriptor.entitlementKey;
    return dto;
  }
}
