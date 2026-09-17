import { WorkflowDefinitionEntity, type WorkflowLineage } from '@arcaai/domains';
import { CORE_PALETTE_KEY, WORKFLOW_NODE_REGISTRY, registryChecksum } from '@arcaai/workflow-contract';
import type { CoreActionDescriptor, WorkflowNodeDescriptor, WorkflowPortDescriptor } from '@arcaai/workflow-contract';
import { FetchResponse } from '../../common';
import {
  PaginatedWorkflowDefinitionResponse,
  WorkflowDefinitionResponse,
  WorkflowLineageAssignmentResponse,
  WorkflowLineageResponse,
  WorkflowNodePortResponse,
  WorkflowNodeResponse,
} from './dto';

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

    // `node-registry.ts` documents that a stamped `registryChecksum`
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
    const registryDrifted =
      entity.registryChecksum !== null && entity.registryChecksum !== undefined && entity.registryChecksum !== dto.currentRegistryChecksum;
    dto.needsReview = entity.needsReview || registryDrifted;
    dto.validatedAt = entity.validatedAt ? entity.validatedAt.toISOString() : null;
    dto.publishedAt = entity.publishedAt ? entity.publishedAt.toISOString() : null;
    dto.deprecatedAt = entity.deprecatedAt ? entity.deprecatedAt.toISOString() : null;
    dto.isActive = entity.isActive;
    dto.sourceTemplateSlug = entity.sourceTemplateSlug ?? null;
    dto.templateLocked = entity.templateLocked ?? false;
    dto.resourceStatus = String(entity.resourceStatus);
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    // TASK-965 (G3) — `updatedBy` on a PUBLISHED row IS the publisher; `publishEntity` stamps it.
    dto.createdBy = entity.createdBy ?? null;
    dto.updatedBy = entity.updatedBy ?? null;
    dto.version = entity.version;
    dto.tags = entity.tags ?? [];
    return dto;
  }

  /** TASK-965 (OD-965-3) — the LINEAGE projection: one slug, not one version row. */
  static toLineageResponse(lineage: WorkflowLineage, assignment: WorkflowLineageAssignmentResponse): WorkflowLineageResponse {
    return {
      slug: lineage.slug,
      name: lineage.name,
      paletteKey: lineage.paletteKey,
      versionCount: lineage.versionCount,
      latestVersionNumber: lineage.latestVersionNumber,
      deprecatedCount: lineage.deprecatedCount,
      active: lineage.active
        ? {
            id: lineage.active.id,
            versionNumber: lineage.active.versionNumber,
            publishedAt: lineage.active.publishedAt ? lineage.active.publishedAt.toISOString() : null,
            publishedBy: lineage.active.publishedBy,
            registryChecksum: lineage.active.registryChecksum,
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
      origin: { sourceTemplateSlug: lineage.origin.sourceTemplateSlug, templateLocked: lineage.origin.templateLocked },
      tags: lineage.tags,
      updatedAt: lineage.updatedAt.toISOString(),
    };
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
    dto.kind = 'node';
    dto.implemented = descriptor.implemented;
    dto.activityName = descriptor.activityName;
    dto.classes = [...descriptor.classes];
    dto.paletteKey = descriptor.paletteKey;
    dto.deprecated = descriptor.deprecated ?? null;
    dto.replacedBy = descriptor.replacedBy ?? null;
    dto.critical = descriptor.critical;
    dto.externalWrite = descriptor.externalWrite;
    dto.defaultTimeoutSeconds = descriptor.defaultTimeoutSeconds;
    dto.defaultMaxAttempts = descriptor.defaultMaxAttempts;
    dto.entitlementKey = descriptor.entitlementKey;
    dto.configSchema = descriptor.configSchema ?? null;

    // task 11. The contract package grew eight fields describing what a node may be
    // WIRED TO, when it runs, and what must hold before a graph containing it publishes — and
    // this field-by-field projection dropped every one of them silently. `inputs`/`outputs` are
    // the ones with teeth: without them the canvas cannot implement `isValidConnection` at all,
    // so a nonsensical wiring (`document -> ner`, the anti-laundering case) looks legal until
    // publish rejects it.
    //
    // Copied rather than referenced: these are frozen registry literals, and handing a caller a
    // live reference to the registry invites a mutation that would outlive the request.
    dto.inputs = descriptor.inputs.map(toPortResponse);
    dto.outputs = descriptor.outputs.map(toPortResponse);
    dto.trigger = descriptor.trigger;
    dto.lane = descriptor.lane;
    dto.requires = [...descriptor.requires];
    dto.idempotent = descriptor.idempotent;
    dto.schemaVersion = descriptor.schemaVersion;
    dto.evalGate = descriptor.evalGate ? { goldenSetId: descriptor.evalGate.goldenSetId, enabled: descriptor.evalGate.enabled } : null;
    return dto;
  }

  /**
   * TASK-893 Phase 4 — project one `CoreActionDescriptor` into the SAME wire shape as a node type.
   *
   * The Studio resolves a `core.action` instance's sockets by looking `config.actionKey` up in the
   * one descriptor map it builds from `GET /admin/workflow-nodes` (`effectiveNodePorts` in
   * `apps/admin-console/src/features/workflow-studio/lib/core-ports.ts`). Until the retirement
   * every action was ALSO a registered node type, so that lookup found its delegate for free.
   * `ACTION_CATALOGUE` is a table of its own now, and an action missing from this payload makes
   * the canvas fall back to `core.action`'s generic SUPERSET — six sockets drawn where the action
   * declares one, and `isValidConnection` accepting wires the delegate refuses. Silently.
   *
   * The five fields an action descriptor does not carry are taken from the HOST `core.action`
   * node type rather than invented here: an action instance IS a `core.action` node, and the
   * catalogue only overrides its ports, config schema, activity, safety flags and lane.
   */
  static toActionResponse(descriptor: CoreActionDescriptor): WorkflowNodeResponse {
    const host = WORKFLOW_NODE_REGISTRY['core.action'];
    const dto = new WorkflowNodeResponse();
    dto.type = descriptor.key;
    // NOT a node type: the palette must not offer it, and a graph must never carry it as a
    // `node.type` — a `core.action` instance names it in `config.actionKey` instead.
    dto.kind = 'action';
    // Every kept action is dispatchable — an unimplemented one would have been dropped, not kept.
    dto.implemented = true;
    dto.activityName = descriptor.activityName;
    dto.classes = [...descriptor.classes];
    dto.paletteKey = CORE_PALETTE_KEY;
    // Nothing in the catalogue is deprecated: the retirement DELETED the legacy vocabulary rather
    // than leaving it flagged, so a `false` here is a fact, not a placeholder.
    dto.deprecated = false;
    dto.replacedBy = null;
    dto.critical = descriptor.critical;
    dto.externalWrite = descriptor.externalWrite;
    dto.defaultTimeoutSeconds = descriptor.defaultTimeoutSeconds;
    dto.defaultMaxAttempts = descriptor.defaultMaxAttempts;
    dto.entitlementKey = descriptor.entitlementKey ?? null;
    dto.configSchema = descriptor.configSchema ?? null;
    dto.inputs = descriptor.ports.inputs.map(toPortResponse);
    dto.outputs = descriptor.ports.outputs.map(toPortResponse);
    dto.lane = descriptor.lane;
    dto.trigger = host.trigger;
    dto.requires = [...host.requires];
    dto.idempotent = host.idempotent;
    dto.schemaVersion = host.schemaVersion;
    // An eval gate is bound to a node TYPE; the catalogue declares none.
    dto.evalGate = null;
    return dto;
  }
}

function toPortResponse(port: WorkflowPortDescriptor): WorkflowNodePortResponse {
  const dto = new WorkflowNodePortResponse();
  dto.name = port.name;
  dto.primitive = port.primitive;
  dto.required = port.required;
  dto.multiple = port.multiple;
  // Undefined on a `control` port — ordering carries no payload, so it names no
  // runtime output key — and on every INPUT port, which is bound by its own `toPort`.
  dto.outputKey = port.outputKey;
  return dto;
}
