import { AgentEntity, AgentModelFallbackEntity, type AgentLineage } from '@arcaai/domains';
import { AGENT_IO_DEFAULTS, type ComposableResolvedPrompt } from '@arcaai/workflow-contract';
import { agentRequiredVariables } from './agent-required-variables';
import { AgentLineageAssignmentResponse, AgentLineageResponse, AgentResponse, AgentSummaryResponse, AgentValidationReportResponse } from './dto';
import { isPlatformHiddenAgentSlug } from './platform-hidden-agents';

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
      sourceAgentId: entity.sourceAgentId ?? null,
      sourceTenantId: entity.sourceTenantId ?? null,
      sourceSlug: entity.sourceSlug ?? null,
      sourceVersionNumber: entity.sourceVersionNumber ?? null,
      status: entity.status,
      isActive: entity.isActive,
      modelId: entity.modelId,
      modelSlug: modelSlugs.get(entity.modelId) ?? null,
      contextSchemaId: entity.contextSchemaId ?? null,
      contextSchemaVersionNumber: entity.contextSchemaVersionNumber ?? null,
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
      // TASK-974 D-1 — DERIVED from the allow-list, never read off the row: `Agent` carries no
      // visibility column, and one would make "hidden" a data edit rather than a platform
      // decision. Only the ADMIN projection carries it; the business-plane summary below never
      // describes a hidden agent because it is never returned one.
      hidden: isPlatformHiddenAgentSlug(entity.slug),
      tags: entity.tags ?? [],
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      createdBy: entity.createdBy ?? null,
      updatedBy: entity.updatedBy ?? null,
      version: entity.version,
    };
  }

  /**
   * TASK-965 (OD-965-3) — the LINEAGE projection: one slug, not one version row.
   *
   * `modelSlugs` is the same map `toResponse` takes (ids are not a thing a person recognises);
   * `assignment` is resolved by the service, because what a slug SERVES lives in
   * `AgentAssignment`, not on any agent row.
   */
  static toLineageResponse(
    lineage: AgentLineage,
    assignment: AgentLineageAssignmentResponse,
    modelSlugs: ReadonlyMap<string, string> = new Map(),
  ): AgentLineageResponse {
    return {
      slug: lineage.slug,
      name: lineage.name,
      task: lineage.task,
      versionCount: lineage.versionCount,
      latestVersionNumber: lineage.latestVersionNumber,
      deprecatedCount: lineage.deprecatedCount,
      active: lineage.active
        ? {
            id: lineage.active.id,
            versionNumber: lineage.active.versionNumber,
            publishedAt: lineage.active.publishedAt ? lineage.active.publishedAt.toISOString() : null,
            publishedBy: lineage.active.publishedBy,
            modelSlug: lineage.active.modelId ? (modelSlugs.get(lineage.active.modelId) ?? null) : null,
            compiledConfigChecksum: lineage.active.compiledConfigChecksum,
          }
        : null,
      draft: lineage.draft
        ? {
            id: lineage.draft.id,
            versionNumber: lineage.draft.versionNumber,
            status: lineage.draft.status,
            updatedAt: lineage.draft.updatedAt.toISOString(),
          }
        : null,
      assignment,
      origin: { sourceTenantId: lineage.origin.sourceTenantId, sourceSlug: lineage.origin.sourceSlug },
      tags: lineage.tags,
      hidden: isPlatformHiddenAgentSlug(lineage.slug),
      updatedAt: lineage.updatedAt.toISOString(),
    };
  }

  /**
   * TASK-983 R9 — the list of placeholders an invocation must supply, as PUBLISHED.
   *
   * `compiledConfig.requiredVariables` is what `compile()` froze and is served verbatim: the
   * read is a projection, never a render. A row published BEFORE this ticket carries no such key
   * — absence means "not computed", never "nothing required" — so it is recomputed here from the
   * artifact's own frozen `resolvedPrompt` + `instruction`. That recomputation is pure string
   * scanning over content already in memory; it is not cached on the entity, because a cache
   * field on a change-tracked domain object buys microseconds and costs an invariant.
   */
  private static requiredVariablesOf(entity: AgentEntity): string[] {
    const compiled = asObject(entity.compiledConfig);
    if (compiled === null) return [];
    const frozen = compiled.requiredVariables;
    if (Array.isArray(frozen)) return frozen.filter((entry): entry is string => typeof entry === 'string');
    return agentRequiredVariables(
      asObject(compiled.instruction) ?? asObject(entity.instruction),
      (compiled.resolvedPrompt ?? null) as ComposableResolvedPrompt,
    );
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
      requiredVariables: AgentDtoMapper.requiredVariablesOf(entity),
    };
  }
}
