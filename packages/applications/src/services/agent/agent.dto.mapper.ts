import { AgentEntity, AgentModelFallbackEntity } from '@arcaai/domains';
import { AGENT_IO_DEFAULTS, AGENT_PROTOCOLS } from '@arcaai/workflow-contract';
import { AgentResponse, AgentSummaryResponse, AgentValidationReportResponse } from './dto';

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : null;
}

export class AgentDtoMapper {
  static toResponse(
    entity: AgentEntity,
    fallbacks: AgentModelFallbackEntity[] = [],
    modelSlugs: ReadonlyMap<string, string> = new Map(),
  ): AgentResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      slug: entity.slug,
      name: entity.name,
      description: entity.description ?? null,
      task: entity.task,
      versionNumber: entity.versionNumber,
      parentVersionId: entity.parentVersionId ?? null,
      status: entity.status,
      isActive: entity.isActive,
      modelId: entity.modelId,
      modelSlug: modelSlugs.get(entity.modelId) ?? null,
      fallbacks: [...fallbacks]
        .sort((a, b) => a.priority - b.priority)
        .map((fallback) => ({
          priority: fallback.priority,
          modelId: fallback.modelId,
          modelSlug: modelSlugs.get(fallback.modelId) ?? null,
          enabled: fallback.enabled,
        })),
      instruction: asObject(entity.instruction),
      parameters: asObject(entity.parameters),
      inputSchema: asObject(entity.inputSchema),
      outputSchema: asObject(entity.outputSchema),
      tools: asArray(entity.tools),
      compiledConfig: asObject(entity.compiledConfig),
      compiledConfigChecksum: entity.compiledConfigChecksum ?? null,
      validationReport: (asObject(entity.validationReport) as unknown as AgentValidationReportResponse | null) ?? null,
      validatedAt: entity.validatedAt ? entity.validatedAt.toISOString() : null,
      publishedAt: entity.publishedAt ? entity.publishedAt.toISOString() : null,
      deprecatedAt: entity.deprecatedAt ? entity.deprecatedAt.toISOString() : null,
      resourceStatus: entity.resourceStatus,
      tags: entity.tags ?? [],
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      createdBy: entity.createdBy ?? null,
      updatedBy: entity.updatedBy ?? null,
      version: entity.version,
    };
  }

  /** The business-plane projection: schemas fall back to the task defaults so an integrator always gets a contract. */
  static toSummary(entity: AgentEntity, isTenantDefault: boolean): AgentSummaryResponse {
    const defaults = AGENT_IO_DEFAULTS[entity.task];
    return {
      slug: entity.slug,
      name: entity.name,
      description: entity.description ?? null,
      task: entity.task,
      versionNumber: entity.versionNumber,
      isTenantDefault,
      inputSchema: asObject(entity.inputSchema) ?? (defaults.inputSchema as Record<string, unknown>),
      outputSchema: asObject(entity.outputSchema) ?? (defaults.outputSchema as Record<string, unknown>),
      protocols: [...AGENT_PROTOCOLS[entity.task]],
    };
  }
}
