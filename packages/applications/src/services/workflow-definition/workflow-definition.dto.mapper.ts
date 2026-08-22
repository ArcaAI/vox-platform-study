import { WorkflowDefinitionEntity } from '@arcaai/domains';
import { registryChecksum } from '@arcaai/workflow-contract';
import type { WorkflowNodeDescriptor } from '@arcaai/workflow-contract';
import { FetchResponse } from '../../common';
import { PaginatedWorkflowDefinitionResponse, WorkflowDefinitionResponse, WorkflowNodeResponse } from './dto';

/**
 * The running node registry's checksum, computed once.
 *
 * `WORKFLOW_NODE_REGISTRY` is `Object.freeze`d at module load and `registryChecksum()` is a pure
 * function of it, so the value cannot change within a process — memoised so mapping a page of
 * definitions costs one sha256, not one per row.
 */
let RUNNING_REGISTRY_CHECKSUM: string | undefined;
function runningRegistryChecksum(): string {
  RUNNING_REGISTRY_CHECKSUM ??= registryChecksum();
  return RUNNING_REGISTRY_CHECKSUM;
}

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

    // TASK-790 W2 (TASK-789 H-2). `node-registry.ts` documents that a stamped `registryChecksum`
    // "is compared against this at read time to trigger NEEDS_REVIEW re-validation" — the
    // comparison was never implemented, so `needsReview` was never assigned `true` anywhere, and
    // the seeded platform-default row (stamped over a 7-entry registry, now 30) has been silently
    // stale ever since.
    //
    // Derived on READ rather than persisted: PUBLISHED rows are hard-immutable by service
    // convention (`assertMutable`), and a read must not mutate. `registryChecksum` is null until
    // publish, so a DRAFT can never drift. The stored column is OR'd, never overwritten, so a row
    // flagged for some other reason stays flagged.
    dto.currentRegistryChecksum = runningRegistryChecksum();
    const registryDrifted = entity.registryChecksum !== null && entity.registryChecksum !== undefined && entity.registryChecksum !== dto.currentRegistryChecksum;
    dto.needsReview = entity.needsReview || registryDrifted;
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
    dto.configSchema = descriptor.configSchema ?? null;
    return dto;
  }
}
