import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
  ResourceType,
  SysEventType,
  WorkflowDefinitionEntity,
  WorkflowDefinitionFactory,
  WorkflowDefinitionRepository,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import type { JsonValue } from '@arcaai/domains';
import { ArgumentInvalidException, QuotaExceededException } from '@arcaai/exceptions';
import {
  canonicalJson,
  compile,
  nodeInfo as registryNodeInfo,
  registryChecksum,
  validate,
  WORKFLOW_NODE_REGISTRY,
  workflowNodeClassLookup,
} from '@arcaai/workflow-contract';
import type { CompiledWorkflowConfig, CompilerContext, WorkflowFinding, WorkflowGraph, WorkflowValidationReport } from '@arcaai/workflow-contract';
import { createHash } from 'node:crypto';
import { assertEqualTenants, BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { KNOWN_PALETTE_KEYS } from '../workflow-exposure/exposure-palette-policy';
import { SttPipelineCompilerService } from './compilers/stt-pipeline.compiler';
import {
  CreateWorkflowDefinitionRequest,
  PaginatedWorkflowDefinitionResponse,
  PublishWorkflowDefinitionRequest,
  SandboxCompileResult,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
  WorkflowNodeRegistryResponse,
} from './dto';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { WorkflowDefinitionDtoMapper } from './workflow-definition.dto.mapper';

const WORKFLOW_DEFINITION_FILTER_MODEL = 'WorkflowDefinition';

/** `WorkflowFinding.ruleId` `validate()` stamps when `workflowGraphProblems` short-circuits the
 *  rule catalogue (`validate.ts`) — the ONLY finding source that is always publish/write-blocking. */
const SHAPE_FINDING_RULE_ID = 'WF-SHAPE';

/** Server-authored compile/validate metadata (TASK-716's design.md §Data flow). Bumping either
 *  is a deliberate release event, not tenant-configurable — same posture as
 *  `WORKFLOW_NODE_REGISTRY`'s `critical`/`externalWrite` fields. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD' as const,
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

/** TASK-724: the STT palette's own key, as authored on `WorkflowDefinition.paletteKey`. Not an
 *  enum in this package (`paletteKey` is a free string on the entity) — a single named constant
 *  so the publish-time entitlement check below and any future STT-specific branch share one
 *  literal, never a re-typed `'stt'` string. */
const STT_PALETTE_KEY = 'stt';

/** The entitlement capability key `mapQuotaCapabilityToHttp` keys its `startsWith('feature') ->
 *  403` branch off — matches `ResolvedFeatures.paletteStt`'s column name `featurePaletteStt`
 *  exactly, mirroring `PLATFORM_DEFAULT_CAPABILITY` in
 *  `ai-provider-connection/assert-provider-available.ts` (the "first ENFORCED boolean
 *  entitlement" precedent this ticket's README §4 Task 7 names). */
const PALETTE_STT_CAPABILITY = 'featurePaletteStt';

/** Whether ANY finding in a report is the hard shape-level short-circuit. When true, `validate()`
 *  evaluated NO rule-catalogue rules at all (`validate.ts`'s early return) — the report carries
 *  only structural-shape problems, always write/publish-blocking. */
function reportIsShapeBroken(report: WorkflowValidationReport): boolean {
  return report.findings.some((finding) => finding.ruleId === SHAPE_FINDING_RULE_ID);
}

/**
 * `WorkflowDefinition` CRUD + the compile/validate/publish lifecycle (TASK-734).
 *
 * See `IWorkflowDefinitionService` for the create/update/validate/publish contract and why a
 * row IS a version. Two engines from `@arcaai/workflow-contract` are wired here, not one:
 *
 * - `compile()` is the ENGINE gate — a cycle or an unregistered node type is a genuine defect
 *   in the authored graph and is ALWAYS rejected (create/update/publish all 400 on it).
 * - `validate()`'s `DRAFT_SUMMARIZATION_RULE_SET` (TASK-716's 22 not-yet-clinically-reviewed
 *   rules, `status: 'DRAFT'` on every rule) is recorded on `validationReport` for visibility
 *   but NEVER blocks a write — decision #3 (TASK-734 §2 Risks & Open Questions): wiring the
 *   engine is not the same as enforcing unreviewed clinical rules. The one exception is a
 *   MALFORMED graph (`workflowGraphProblems`), which `validate()` also short-circuits into —
 *   `reportIsShapeBroken` is how this service tells "genuinely broken" from "a DRAFT rule
 *   fired" apart, since both land in the same `report.findings` array.
 */
@Injectable()
export class WorkflowDefinitionService extends BaseService implements IWorkflowDefinitionService {
  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional so unit fixtures can construct without it; production DI
    // (EntitlementsServiceModule) always supplies it.
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // TASK-724 Task 4 — optional for the same reason (unit-fixture construction); production DI
    // (WorkflowDefinitionServiceModule importing PipelineServiceModule) always supplies it. A
    // publish() of an `stt`-palette workflow with this undefined is a MISCONFIGURATION, not a
    // silently-skipped feature — see the doc comment on `compileSttPipelineIfNeeded` below.
    @Optional() private readonly sttPipelineCompiler?: SttPipelineCompilerService,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  // ============================================================
  // CRUD
  // ============================================================

  async list(query: PaginatedQuery): Promise<PaginatedWorkflowDefinitionResponse> {
    const { limit, page } = query;
    const paginatedProps = withFormattedPaginatedProps(query, WORKFLOW_DEFINITION_FILTER_MODEL);
    const countProps = withFormattedCountProps(query, WORKFLOW_DEFINITION_FILTER_MODEL);

    const rows = await this.workflowDefinitionRepository.findAll(paginatedProps);
    const count = await this.workflowDefinitionRepository.count(countProps);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { items: rows.map((row) => row.id) } });

    return WorkflowDefinitionDtoMapper.toPaginatedResponse(new FetchResponse({ data: rows, count, limit: limit ?? 10, page: page ?? 0 }));
  }

  async getById(id: string): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });

    return WorkflowDefinitionDtoMapper.toResponse(entity);
  }

  async listVersions(id: string): Promise<WorkflowDefinitionResponse[]> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const versions = await this.workflowDefinitionRepository.findAllVersionsBySlug(entity.tenantId, entity.slug);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id, data: { action: 'listVersions', count: versions.length } });

    return versions.map((version) => WorkflowDefinitionDtoMapper.toResponse(version));
  }

  async create(dto: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    // Plan quota precheck. Only pay the COUNT when the kill-switch is ON — `assertQuantityQuota`
    // throws `QuotaExceededException` (-> 409) when creating one more would exceed
    // `maxWorkflowDefinitions`, grandfathering existing rows. Counts every version row for the
    // tenant, mirroring `DepartmentService.create`'s `maxDepartments` precheck.
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.workflowDefinitionRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxWorkflowDefinitions', currentCount);
    }

    this.assertKnownPaletteKey(dto.paletteKey);

    const graph = this.parseGraphOrThrow(dto.graph);
    const report = this.validateGraph(graph, dto.paletteKey);
    if (reportIsShapeBroken(report)) {
      throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: report.findings });
    }

    if (dto.parentVersionId) {
      const parent = await this.workflowDefinitionRepository.findById(dto.parentVersionId).catch(() => null);
      if (!parent || parent.tenantId !== tenantId || parent.slug !== dto.slug) {
        throw new BadRequestException(`Unknown parentVersionId '${dto.parentVersionId}' for slug '${dto.slug}'.`);
      }
    }

    // The version-number mint and the row insert run inside a SINGLE interactive transaction
    // (prompt-management.service.ts's discipline) — `max(existing) + 1` queried FROM THE TX
    // CLIENT, never a value computed outside it, so a concurrent create for the same slug
    // cannot mint the same versionNumber and trip the `(tenantId, slug, versionNumber)` unique
    // constraint.
    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      const maxVersionNumber = await this.workflowDefinitionRepository.findMaxVersionNumber(tenantId, dto.slug, tx);
      const entity = WorkflowDefinitionFactory.CreateDefinition({
        tenantId,
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        paletteKey: dto.paletteKey,
        versionNumber: maxVersionNumber + 1,
        parentVersionId: dto.parentVersionId ?? null,
        graph: graph as unknown as JsonValue,
        graphChecksum: graphChecksum(graph),
        validationReport: report as unknown as JsonValue,
        validatedAt: new Date(),
        createdBy: this.requestUserId ?? undefined,
      });

      // The engine gate: compile() needs the entity's client-generated id/versionNumber, both
      // already assigned by the factory before this insert — so a genuinely uncompilable graph
      // (cycle, unregistered node type) is rejected BEFORE anything is written, not after.
      this.compileGraphOrThrow(entity, graph);

      return this.workflowDefinitionRepository.create(entity, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, versionNumber: saved.versionNumber, paletteKey: saved.paletteKey },
    });

    return WorkflowDefinitionDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);

    const { expectedVersion, graph: rawGraph, ...editableChanges } = dto;

    if (rawGraph !== undefined) {
      const graph = this.parseGraphOrThrow(rawGraph);
      const report = this.validateGraph(graph, entity.paletteKey);
      if (reportIsShapeBroken(report)) {
        throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: report.findings });
      }
      this.compileGraphOrThrow(entity, graph);

      entity.graph = graph as unknown as JsonValue;
      entity.graphChecksum = graphChecksum(graph);
      entity.validationReport = report as unknown as JsonValue;
      entity.validatedAt = new Date();
      // A graph edit invalidates any prior VALIDATED/compiled state — back to DRAFT.
      entity.status = WorkflowDefinitionStatus.DRAFT;
    }

    await this.updateEntity(entity, editableChanges);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = entity.version;
    const updated = await this.workflowDefinitionRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return WorkflowDefinitionDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const deleted = await this.workflowDefinitionRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { slug: deleted.slug, versionNumber: deleted.versionNumber },
    });

    return WorkflowDefinitionDtoMapper.toResponse(deleted);
  }

  // ============================================================
  // Validate / publish
  // ============================================================

  async validate(id: string): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);

    const graph = entity.graph as unknown as WorkflowGraph;
    const report = this.validateGraph(graph, entity.paletteKey);
    const compileResult = compile(graph, this.buildCompilerContext(entity));
    const engineClean = !reportIsShapeBroken(report) && !('findings' in compileResult);

    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    // DRAFT rule-catalogue findings never block this transition (decision #3) — only the
    // engine gate (shape + compile()) decides DRAFT -> VALIDATED.
    entity.status = engineClean ? WorkflowDefinitionStatus.VALIDATED : WorkflowDefinitionStatus.DRAFT;

    if (!entity.hasChanges) {
      return WorkflowDefinitionDtoMapper.toResponse(entity);
    }

    const previousVersion = entity.version;
    const updated = await this.workflowDefinitionRepository.updateWithVersion(id, entity, entity.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'validate', previousVersion, newVersion: updated.version, ok: engineClean },
    });

    return WorkflowDefinitionDtoMapper.toResponse(updated);
  }

  async publish(id: string, dto: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);
    await this.assertPaletteEntitled(entity);

    const graph = entity.graph as unknown as WorkflowGraph;
    const report = this.validateGraph(graph, entity.paletteKey);
    if (reportIsShapeBroken(report)) {
      throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: report.findings });
    }

    const compiled = this.compileGraphOrThrow(entity, graph);

    // TASK-724 Task 4 — an `stt`-palette publish ALSO compiles the graph into an
    // `AsrPipeline`/`AsrPipelineVersion` row (README §1's central design decision). Runs BEFORE
    // any entity mutation below: a failure here (e.g. no `stt.asrEngine` node) must abort the
    // publish with nothing written, exactly like the engine gate above.
    const asrPipeline = await this.compileSttPipelineIfNeeded(entity, compiled);

    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    entity.compiledConfig = compiled as unknown as JsonValue;
    entity.compiledConfigChecksum = compiled.checksum;
    entity.registryChecksum = registryChecksum();
    entity.status = WorkflowDefinitionStatus.PUBLISHED;
    entity.publishedAt = new Date();

    const activate = dto.activate ?? true;
    if (activate) {
      entity.isActive = true;
      await this.demoteExistingActive(entity.tenantId, entity.slug, entity.id);
    }

    // Publish is not a CAS (`consultation-context-schema.service.ts`'s discipline) — an
    // unrelated concurrent metadata edit must not 412 the publish.
    const updated = await this.workflowDefinitionRepository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        action: 'publish',
        versionNumber: updated.versionNumber,
        compiledConfigChecksum: updated.compiledConfigChecksum,
        activate,
        ...(asrPipeline ? { asrPipelineId: asrPipeline.id, asrPipelineSlug: asrPipeline.slug } : {}),
      },
    });

    return WorkflowDefinitionDtoMapper.toResponse(updated);
  }

  // ============================================================
  // Node registry (read-only projection)
  // ============================================================

  async listNodes(): Promise<WorkflowNodeRegistryResponse> {
    return {
      nodes: Object.values(WORKFLOW_NODE_REGISTRY)
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((descriptor) => WorkflowDefinitionDtoMapper.toNodeResponse(descriptor)),
      registryChecksum: registryChecksum(),
    };
  }

  // ============================================================
  // Sandbox compile (TASK-721 Workbench — read, never a lifecycle transition)
  // ============================================================

  async getCompiledConfigForSandboxRun(id: string): Promise<SandboxCompileResult> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const graph = entity.graph as unknown as WorkflowGraph;
    const compiledConfig = this.compileGraphOrThrow(entity, graph);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id, data: { action: 'sandboxCompile' } });

    return {
      compiledConfig,
      workflowVersionId: entity.id,
      workflowSlug: entity.slug,
      workflowVersionNumber: entity.versionNumber,
      definitionName: entity.name,
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  /** PUBLISHED/DEPRECATED rows are hard-immutable by SERVICE convention
   *  (`workflow-definition.prisma`'s file header §3.4) — modelled on
   *  `prompt-management.service.ts`'s `assertCanMutate`. */
  private assertMutable(entity: WorkflowDefinitionEntity): void {
    if (entity.status === WorkflowDefinitionStatus.PUBLISHED || entity.status === WorkflowDefinitionStatus.DEPRECATED) {
      throw new BadRequestException(`WorkflowDefinition ${entity.id} is ${entity.status} and can no longer be edited. Branch a new draft instead.`);
    }
  }

  /**
   * TASK-790 W1 (TASK-789 C-5/D-5) — `paletteKey` must name a palette the node registry actually
   * declares. The DTO only constrains it to a string of at most 80 chars, and Workflow Studio's
   * palette field is a free-text `<Input>`, so a typo ('summarisation', 'Consultation') would
   * otherwise produce a row that is published-looking but permanently inert: `validate()` skips
   * every rule whose `paletteKey` does not match (`validate.ts`), so NO palette rule set ever
   * applies, and the Assignment Matrix has no column to offer it under.
   *
   * Create-only by design: `UpdateWorkflowDefinitionRequest` carries no `paletteKey`, so a
   * definition's palette is immutable after creation and there is no update path to guard.
   *
   * The valid set is DERIVED from `WORKFLOW_NODE_REGISTRY` (see `KNOWN_PALETTE_KEYS`), never
   * re-typed here — a palette added to the registry is accepted with no edit to this service.
   */
  private assertKnownPaletteKey(paletteKey: string): void {
    if (KNOWN_PALETTE_KEYS.has(paletteKey)) return;
    const known = [...KNOWN_PALETTE_KEYS].sort().join(', ');
    throw new BadRequestException(`Unknown paletteKey '${paletteKey}'. Known palettes: ${known}.`);
  }

  /**
   * TASK-724 Task 7 — publish-time-only entitlement gate, imitating
   * `assertProviderAvailable`'s `QuotaExceededException` call site (the "first ENFORCED boolean
   * entitlement" precedent). Checked ONLY here, never at runtime: an already-published
   * `stt`-palette workflow keeps running its compiled `AsrPipeline` even if the tenant's grant
   * flips off later ("in-flight runs pin their version; publishes affect new runs only" —
   * design.md's Data Flow section). A no-op for every other palette and, per
   * `isFeatureEnabled`'s own contract, a no-op while the entitlements kill-switch is OFF.
   */
  private async assertPaletteEntitled(entity: Pick<WorkflowDefinitionEntity, 'paletteKey' | 'tenantId'>): Promise<void> {
    if (entity.paletteKey !== STT_PALETTE_KEY || !this.entitlements) return;

    const allowed = await this.entitlements.isFeatureEnabled(entity.tenantId, 'paletteStt');
    if (!allowed) {
      throw new QuotaExceededException(`This tenant is not entitled to publish '${STT_PALETTE_KEY}'-palette workflows.`, {
        capability: PALETTE_STT_CAPABILITY,
        limit: 0,
        used: 0,
        requested: 1,
      });
    }
  }

  /**
   * TASK-724 Task 4 — an `stt`-palette publish compiles the graph into an `AsrPipeline` +
   * `AsrPipelineVersion` row (README §1). No-op (`null`) for every other palette. When the
   * palette IS `stt` but `sttPipelineCompiler` was never wired, this is a deployment
   * misconfiguration, not a case to skip quietly — `WorkflowDefinitionServiceModule` always
   * supplies it in production; only unit fixtures construct without it (and none of them
   * publish an `stt`-palette graph without also stubbing this).
   */
  private async compileSttPipelineIfNeeded(
    entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'name' | 'paletteKey'>,
    compiled: CompiledWorkflowConfig,
  ): Promise<{ id: string; slug: string } | null> {
    if (entity.paletteKey !== STT_PALETTE_KEY) return null;
    if (!this.sttPipelineCompiler) {
      throw new Error(
        `Cannot publish stt-palette WorkflowDefinition '${entity.id}': SttPipelineCompilerService is not wired (misconfiguration — see WorkflowDefinitionServiceModule).`,
      );
    }
    const pipeline = await this.sttPipelineCompiler.compileAndPublish(entity, compiled);
    return { id: pipeline.id, slug: pipeline.slug };
  }

  private parseGraphOrThrow(raw: Record<string, unknown>): WorkflowGraph {
    // Structural shape (id grammar, bounds, dangling edges) is re-checked by `validate()`
    // immediately after this — this cast only gives the compiler/validator a typed shape to
    // walk; `workflowGraphProblems` inside `validate()` is what actually rejects malformed
    // input (never trusted here).
    return raw as unknown as WorkflowGraph;
  }

  private validateGraph(graph: WorkflowGraph, paletteKey: string): WorkflowValidationReport {
    return validate(
      graph,
      { paletteKey, registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum() },
    );
  }

  private buildCompilerContext(entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'tenantId' | 'paletteKey'>): CompilerContext {
    return {
      definitionId: entity.id,
      slug: entity.slug,
      versionNumber: entity.versionNumber,
      tenantId: entity.tenantId,
      paletteKey: entity.paletteKey,
      compilerVersion: COMPILER_VERSION,
      registryChecksum: registryChecksum(),
      ruleSetVersion: RULE_SET_VERSION,
      caps: DEFAULT_CAPS,
      policyBindings: DEFAULT_POLICY_BINDINGS,
      nodeInfo: registryNodeInfo,
    };
  }

  /** The engine gate: throws (400) if `compile()` cannot turn `graph` into a `CompiledWorkflowConfig`
   *  (a cycle, or a node type `WORKFLOW_NODE_REGISTRY` does not resolve). */
  private compileGraphOrThrow(
    entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'tenantId' | 'paletteKey'>,
    graph: WorkflowGraph,
  ): CompiledWorkflowConfig {
    const result = compile(graph, this.buildCompilerContext(entity));
    if ('findings' in result) {
      throw new BadRequestException({ message: 'The workflow graph could not be compiled.', findings: result.findings satisfies WorkflowFinding[] });
    }
    return result.config;
  }

  /** At most one ACTIVE version per `(tenantId, slug)` — mirrors
   *  `ConsultationContextSchemaService.demoteExistingDefault` / `DepartmentAgent.isDefault`. */
  private async demoteExistingActive(tenantId: string, slug: string, exceptId: string): Promise<void> {
    const current = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!current || current.id === exceptId) return;
    current.isActive = false;
    current.updatedBy = this.requestUserId ?? undefined;
    await this.workflowDefinitionRepository.update(current.id, current);
  }
}

function graphChecksum(graph: WorkflowGraph): string {
  return createHash('sha256').update(canonicalJson(graph)).digest('hex');
}
