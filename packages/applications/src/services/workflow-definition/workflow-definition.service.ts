import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
  PromptTemplateRepository,
  PromptVersionFactory,
  PromptVersionRepository,
  ResourceType,
  SysEventType,
  SYSTEM_TENANT_ID,
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
  hyperparameterCapabilityProblems,
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
import { IConsultationContextSchemaService } from '../consultation-context-schema/IConsultationContextSchemaService';
import type { IConsultationContextSchemaService as IConsultationContextSchemaServicePort } from '../consultation-context-schema/IConsultationContextSchemaService';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { KNOWN_PALETTE_KEYS } from '../workflow-exposure/exposure-palette-policy';
import { WorkflowValidatorService } from '../workflow-validator/workflow-validator.service';
import { SttPipelineCompilerService } from './compilers/stt-pipeline.compiler';
import {
  CloneWorkflowDefinitionRequest,
  CreateWorkflowDefinitionRequest,
  NodePromptBindingResponse,
  NodePromptUpdateResponse,
  PaginatedWorkflowDefinitionResponse,
  PublishWorkflowDefinitionRequest,
  SandboxCompileResult,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
  WorkflowNodeRegistryResponse,
} from './dto';
import { collectGenerationBindings } from './node-generation-binding';
import { collectPromptBindings, promptContentChecksum, withMovedPin } from './node-prompt-binding';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import type { IAiRoutingPolicyService as IAiRoutingPolicyServicePort } from '../ai-routing-policy/IAiRoutingPolicyService';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { WorkflowDefinitionDtoMapper } from './workflow-definition.dto.mapper';

const WORKFLOW_DEFINITION_FILTER_MODEL = 'WorkflowDefinition';

/** `WorkflowFinding.ruleId` `validate()` stamps when `workflowGraphProblems` short-circuits the
 *  rule catalogue (`validate.ts`) — the ONLY finding source that is always publish/write-blocking. */
const SHAPE_FINDING_RULE_ID = 'WF-SHAPE';

/**
 * TASK-847 finding F-32 — the rule id every hyper-parameter capability finding carries.
 *
 * Distinct from the DRAFT rule catalogue so `publish()` can tell "a clinically-unreviewed rule
 * fired" (never blocking, decision #3) from "this graph tunes a parameter that reaches nothing"
 * (blocking) apart, exactly as `SHAPE_FINDING_RULE_ID` separates a malformed graph from both.
 */
const HYPERPARAMETER_CAPABILITY_RULE_ID = 'WF-CAP-001';

/** Server-authored compile/validate metadata (TASK-716's design.md §Data flow). Bumping either
 *  is a deliberate release event, not tenant-configurable — same posture as
 *  `WORKFLOW_NODE_REGISTRY`'s `critical`/`externalWrite` fields. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };

/**
 * The two `policyBindings` fields that are NOT derivable from the graph.
 *
 * This constant used to carry all five, and every compile passed it verbatim — which is what
 * D-7 recorded: a published graph pinned NOTHING. `contextSchemaVersionId`, `promptTemplateRefs`
 * and `entitlementKeys` are now derived per compile (see `buildCompilerContext`), leaving only
 * the two below, whose values genuinely have no source in the graph yet.
 *
 * `guardrailProfile` selects PLACEMENT, not permission — the actual clinical-safety enforcement
 * runs at a boundary this field only names — so a fixed `STANDARD` here is not a safety
 * shortcut. When a real per-tenant guardrail profile and redaction rule set exist, they resolve
 * the same way the context schema now does.
 */
const NON_DERIVABLE_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD' as const,
  redactionRuleSetId: null,
};

/** TASK-810 DD-2 — the two config keys a generation node carries its DOCUMENT-SHAPE binding in.
 *  Declared as schema properties by `DOCUMENT_BINDING_PROPERTIES` in `@arcaai/workflow-contract`'s
 *  `node-config-schemas.ts`; named here for the same reason `PROMPT_TEMPLATE_ID_KEY` is named in
 *  `node-prompt-binding.ts` — the derivation below reads raw node config, and a re-typed string
 *  literal is how the two sides drift apart. */
const DOCUMENT_TEMPLATE_ID_KEY = 'documentTemplateId';
const DOCUMENT_VERSION_NUMBER_KEY = 'documentVersionNumber';

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
    // TASK-790 W3(a) — the rule-row resolver. `@Optional()` for the same reason as the two
    // above (unit-fixture construction); production DI always supplies it via
    // `WorkflowValidatorServiceModule`. When absent, `validateGraph` falls back to the bundled
    // code-owned DRAFT catalogue — the behaviour that was UNIVERSAL before this ticket, so the
    // fallback cannot be less safe than the previous state.
    @Optional() private readonly workflowValidator?: WorkflowValidatorService,
    // DD-11 — the prompt plane. Optional + trailing so existing positional unit
    // fixtures keep their arity; production DI (WorkflowDefinitionServiceModule
    // importing CoreDatabaseModule) always supplies both. Absent ⇒ the two
    // prompt-binding surfaces below refuse rather than half-work.
    @Optional() private readonly promptTemplateRepository?: PromptTemplateRepository,
    @Optional() private readonly promptVersionRepository?: PromptVersionRepository,
    // D-7 — the tenant's context-schema pin. `@Optional()` + trailing for the same reason as
    // the four above (positional unit fixtures); production DI supplies it via
    // `ConsultationContextSchemaServiceModule`. Absent ⇒ the pin resolves to `null` and the
    // publish still succeeds: an unpinned artifact is worse than a pinned one, but refusing to
    // publish at all would be worse than both, and the graph-derived bindings do not need it.
    @Optional() @Inject(IConsultationContextSchemaService) private readonly contextSchemaService?: IConsultationContextSchemaServicePort,
    // TASK-847 F-32 — the provider plane, for the hyper-parameter capability gate.
    // `@Optional()` + trailing for the same reason as the five above (positional unit fixtures);
    // production DI supplies it via `AiRoutingPolicyServiceModule`. Absent ⇒ no capability set
    // resolves, so every tuned node reports the UNKNOWN warning and publish still succeeds —
    // which is the same posture as an unprofiled configuration, and strictly safer than a gate
    // that fails a publish because its own dependency was missing.
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicyService?: IAiRoutingPolicyServicePort,
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
    const report = await this.validateGraph(graph, dto.paletteKey, tenantId);
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
      //
      // The compiled artifact is DISCARDED here — this call is a yes/no gate, not a stamp — so
      // the context-schema pin is passed as `null` rather than resolved: it could not reach any
      // persisted row, and reading it would add a DB round-trip inside this transaction for a
      // value nothing consumes.
      this.compileGraphOrThrow(entity, graph, null);

      return this.workflowDefinitionRepository.create(entity, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, versionNumber: saved.versionNumber, paletteKey: saved.paletteKey },
    });

    return WorkflowDefinitionDtoMapper.toResponse(saved);
  }

  /**
   * TASK-856 — seed a NEW lineage from an existing definition. See
   * `IWorkflowDefinitionService.clone` for the contract; the two things worth reading in the
   * code below are WHERE the slug-collision check sits (inside the transaction, fused with the
   * version mint) and WHAT is deliberately not carried over from the source row.
   */
  async clone(sourceId: string, dto: CloneWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    // Byte-for-byte the precheck `create` runs. A clone writes a row, so a clone path that
    // skipped this would be a `maxWorkflowDefinitions` bypass with extra steps.
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.workflowDefinitionRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxWorkflowDefinitions', currentCount);
    }

    // `tenantId IN [caller, SYSTEM]`, SYSTEM narrowed to the live published library. Another
    // customer tenant's id resolves to `null` here and leaves as a 404, exactly like an id that
    // never existed (404-over-403).
    const source = await this.workflowDefinitionRepository.findCloneSource(sourceId, tenantId, this.databaseService.baseClient);
    if (!source) {
      throw new NotFoundException(`WorkflowDefinition ${sourceId} was not found.`);
    }

    const fromSystemTemplate = source.tenantId === SYSTEM_TENANT_ID;
    const graph = this.parseGraphOrThrow(source.graph as unknown as Record<string, unknown>);
    if (fromSystemTemplate) {
      this.assertNoUnresolvableCatalogBindings(graph);
    }

    this.assertKnownPaletteKey(source.paletteKey);

    // Recomputed for THIS tenant against the CURRENT registry — never copied. A report produced
    // under another tenant's invariant rules, or against an older registry, is a stale claim
    // about a graph that now lives somewhere else.
    const report = await this.validateGraph(graph, source.paletteKey, tenantId);
    if (reportIsShapeBroken(report)) {
      throw new BadRequestException({ message: 'The source workflow graph is not valid.', findings: report.findings });
    }

    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      // The collision check IS the version mint, read from the TX client. `create` would have
      // happily minted `max + 1` here — which is precisely the failure a clone must not have:
      // a "clone" landing as version N+1 of a lineage that may be published and serving
      // traffic. Doing it inside the transaction also closes the check-then-write window
      // against a concurrent clone into the same slug; the `(tenantId, slug, versionNumber)`
      // unique index is the backstop behind that.
      const maxVersionNumber = await this.workflowDefinitionRepository.findMaxVersionNumber(tenantId, dto.targetSlug, tx);
      if (maxVersionNumber > 0) {
        throw new ConflictException(
          `Slug '${dto.targetSlug}' is already in use by this tenant. Choose another slug, or open that workflow and create a new version of it instead.`,
        );
      }

      const entity = WorkflowDefinitionFactory.CreateDefinition({
        tenantId,
        slug: dto.targetSlug,
        name: dto.name ?? `${source.name} (copy)`,
        description: dto.description ?? source.description ?? null,
        paletteKey: source.paletteKey,
        versionNumber: maxVersionNumber + 1,
        // A clone is a NEW lineage. `parentVersionId` means "branched inside THIS slug"
        // (`create` enforces `parent.slug === dto.slug`), so a cross-slug parent is
        // structurally wrong here, not merely unused.
        parentVersionId: null,
        graph: source.graph,
        graphChecksum: graphChecksum(graph),
        validationReport: report as unknown as JsonValue,
        validatedAt: new Date(),
        createdBy: this.requestUserId ?? undefined,
      });

      // Every server-owned publish column is left at its factory default: `compiledConfig` +
      // both checksums null, `publishedAt`/`deprecatedAt` null, `status` DRAFT, `isActive`
      // false, `tags` empty. A clone has been reviewed by nobody, and the SYSTEM template's
      // `['platform-default', …]` tags would assert something false about a tenant row.
      this.compileGraphOrThrow(entity, graph, null);

      return this.workflowDefinitionRepository.create(entity, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        slug: saved.slug,
        versionNumber: saved.versionNumber,
        paletteKey: saved.paletteKey,
        clonedFromId: sourceId,
        clonedFromSystemTemplate: fromSystemTemplate,
      },
    });

    return WorkflowDefinitionDtoMapper.toResponse(saved);
  }

  /** TASK-856 — the SYSTEM template library, read-only. */
  async listTemplates(): Promise<WorkflowDefinitionResponse[]> {
    const templates = await this.workflowDefinitionRepository.findSystemTemplates(this.databaseService.baseClient);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { action: 'listTemplates', items: templates.map((template) => template.id) } });

    return templates.map((template) => WorkflowDefinitionDtoMapper.toResponse(template));
  }

  async update(id: string, dto: UpdateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);

    const { expectedVersion, graph: rawGraph, ...editableChanges } = dto;

    if (rawGraph !== undefined) {
      const graph = this.parseGraphOrThrow(rawGraph);
      const report = await this.validateGraph(graph, entity.paletteKey, entity.tenantId);
      if (reportIsShapeBroken(report)) {
        throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: report.findings });
      }
      // Engine gate only — the compiled artifact is discarded and a graph edit resets the row to
      // DRAFT, so there is nothing here for a context-schema pin to be stamped onto.
      this.compileGraphOrThrow(entity, graph, null);

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
    const report = await this.validateGraph(graph, entity.paletteKey, entity.tenantId);
    // Same bindings publish() will stamp — a validate() that compiled against different
    // policyBindings would greenlight an artifact the publish then produces differently.
    const compileResult = compile(graph, this.buildCompilerContext(entity, graph, await this.resolveContextSchemaVersionId()));
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
    const report = await this.validateGraph(graph, entity.paletteKey, entity.tenantId);
    if (reportIsShapeBroken(report)) {
      throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: report.findings });
    }

    // TASK-847 F-32 — the gate, at the moment it matters. A node that tunes a parameter its bound
    // provider configuration does not accept is refused HERE, at authoring time, rather than
    // having the value silently dropped on the wire during a clinical consultation. WARNING-level
    // capability findings (an unprofiled configuration) are recorded on the report and do NOT
    // block — "unknown" is not "unsupported", and blocking on it would gate the platform on data
    // entry. Runs BEFORE compile and before any entity mutation, so a refusal writes nothing.
    const capabilityErrors = report.findings.filter(
      (finding) => finding.ruleId === HYPERPARAMETER_CAPABILITY_RULE_ID && finding.severity === 'ERROR',
    );
    if (capabilityErrors.length > 0) {
      throw new BadRequestException({
        message: 'The workflow sets generation hyper-parameters the bound provider configuration does not accept.',
        findings: capabilityErrors,
      });
    }

    // D-7 — resolve the tenant's context-schema pin BEFORE compiling, so the published artifact
    // records WHICH schema version it was built against instead of a hardcoded null.
    const compiled = this.compileGraphOrThrow(entity, graph, await this.resolveContextSchemaVersionId());

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
    // The sandbox must preview exactly what publish would stamp, bindings included.
    const compiledConfig = this.compileGraphOrThrow(entity, graph, await this.resolveContextSchemaVersionId());

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
  // ============================================================
  // DD-11 — prompt binding, and its two update paths
  // ============================================================

  /**
   * PATH 1 — edit a node's prompt FROM WITHIN THE NODE.
   *
   * Mints a new `PromptVersion` AND moves THIS node's pin to it, in ONE
   * transaction. The atomicity is the requirement, not a nicety: two separate
   * writes leave a window in which either a version exists that no node points
   * at, or a node's pin names a version the second write never created — and
   * the second failure mode is a workflow that cannot resolve its own prompt.
   *
   * Note that the `ConsultationContextSchema` publish flow this ticket's
   * catalog otherwise copies has NO transaction (its version insert and its pin
   * move are two independent writes). That is survivable there because a
   * dangling pin degrades to "fall through to the next tier". It is not
   * survivable here, so this path deliberately does NOT follow that precedent.
   *
   * Only a MUTABLE definition may be edited: a PUBLISHED graph is immutable by
   * the same rule `update()` enforces, so re-pointing a published workflow's
   * prompt means branching a new draft.
   *
   * @throws NotFoundException — unknown/cross-tenant definition, unknown node,
   *   or a template owned by another tenant (404-over-403 throughout)
   * @throws BadRequestException — the definition is PUBLISHED/DEPRECATED, or the
   *   node carries no `promptTemplateId` to edit
   */
  async updateNodePrompt(id: string, nodeId: string, dto: UpdateNodePromptRequest): Promise<NodePromptUpdateResponse> {
    if (!this.promptTemplateRepository || !this.promptVersionRepository) {
      throw new BadRequestException('The prompt plane is not available in this deployment.');
    }

    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);

    // RFC 7232 §13.1 — the precondition is a property of the REQUEST against the
    // CURRENT state, so it is evaluated BEFORE either branch below and
    // regardless of what the payload would change. Without it HERE, a stale
    // client submitting identical content would fall into the no-mint path,
    // receive a 200, and move a pin on a definition it has not seen.
    // `@RequiresIfMatch()` on the route turns a MISSING header into 428; this
    // turns a STALE one into 412.
    this.assertExpectedVersion(entity, dto.expectedVersion);

    const graph = entity.graph as unknown as WorkflowGraph;
    const binding = collectPromptBindings(graph).find((candidate) => candidate.nodeId === nodeId);
    if (!binding) {
      throw new BadRequestException(
        `Node '${nodeId}' does not reference a prompt template. A generation node must carry \`promptTemplateId\` before its prompt can be edited.`,
      );
    }

    const template = await this.promptTemplateRepository.findById(binding.promptTemplateId).catch(() => null);
    if (!template || template.tenantId !== entity.tenantId) {
      // A node pinned to a template this tenant does not own is a broken graph,
      // not an authorization decision to explain — 404-over-403.
      throw new NotFoundException(`Prompt template ${binding.promptTemplateId} not found`);
    }

    const userId = this.requestUserId ?? null;
    const previousVersionNumber = binding.pinnedVersionNumber;

    // §7b item 1 — ADOPT vs AUTHOR.
    //
    // DD-11 PATH 2 leaves node pins alone when a template is edited out of band,
    // which makes ADOPTION the common path, not the rare one. Minting a
    // byte-identical version on every adopt therefore filled the very version
    // list an admin opens to understand what changed. Identical content is a pin
    // move; different content is an authoring act.
    //
    // Compared against the template's LATEST version, deliberately — not against
    // the version the node happens to be pinned to, which differs whenever a node
    // is two or more versions behind:
    //   * the request carries only `content`. It never names a version, so the
    //     only version identity the server has is `max(versionNumber)`;
    //   * `PromptTemplate.content` (the SHARED head) tracks the latest version's
    //     content by invariant — every mint path writes both. A pure pin move must
    //     not rewrite that head, so only "identical to latest" leaves head and pin
    //     in a state the mint path could also have produced. Pinning to an older
    //     matching row would either strand the head ahead of the pin or silently
    //     rewrite a template every other node reads — exactly what DD-11 forbids;
    //   * both in-repo precedents compare against latest only
    //     (`ConsultationContextSchemaService.publish`, and `approve`'s
    //     `latestMatchesLiveContent` in `PromptManagementService`).
    // The corollary is intended: submitting an OLDER body while the template sits
    // on a newer one is a REVERT — a fresh decision about a shared template — and
    // still mints.
    const latest = await this.promptVersionRepository.findLatestVersion(template.id);
    const incomingChecksum = promptContentChecksum(dto.content, dto.variables ?? template.variables);

    if (latest && promptContentChecksum(latest.content, latest.variables) === incomingChecksum) {
      const adoptedVersionNumber = latest.versionNumber;

      // Already pinned there: write NOTHING — not the graph, not `_version`, not
      // an audit row. A repeated save has to be a true no-op, or it re-creates
      // the noise this guard removes, one row down.
      if (previousVersionNumber === adoptedVersionNumber) {
        return {
          ...WorkflowDefinitionDtoMapper.toResponse(entity),
          promptVersionMinted: false,
          promptVersionNumber: adoptedVersionNumber,
          previousPromptVersionNumber: previousVersionNumber,
        };
      }

      const moved = withMovedPin(graph, nodeId, adoptedVersionNumber);
      if (!moved) {
        // Unreachable given the binding lookup above.
        throw new BadRequestException(`Node '${nodeId}' could not be re-pinned.`);
      }
      entity.graph = moved as unknown as JsonValue;
      entity.updatedBy = userId ?? undefined;

      // ONE write, so no `$transaction`: there is no second write for it to be
      // atomic with. `changeReason` is deliberately dropped on this path — the
      // version it would annotate already exists and is immutable, and the
      // response says `promptVersionMinted: false` so the caller is not misled.
      const adopted = await this.workflowDefinitionRepository.updateWithVersion(id, entity, dto.expectedVersion ?? entity.version);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: id,
        data: {
          action: 'node-prompt-adopt',
          nodeId,
          promptTemplateId: template.id,
          previousVersionNumber,
          versionNumber: adoptedVersionNumber,
          minted: false,
        },
      });

      return {
        ...WorkflowDefinitionDtoMapper.toResponse(adopted),
        promptVersionMinted: false,
        promptVersionNumber: adoptedVersionNumber,
        previousPromptVersionNumber: previousVersionNumber,
      };
    }

    const { updated, versionNumber } = await this.databaseService.baseClient.$transaction(async (tx) => {
      // `max(existing) + 1` read inside the transaction, NOT
      // `currentVersionNumber + 1`: a lagging counter or an orphaned history row
      // would otherwise recompute an existing versionNumber and trip the
      // `(promptTemplateId, versionNumber)` unique constraint, bricking further
      // edits of the template. Same reasoning as `updatePromptTemplate`.
      const nextVersionNumber = (await this.promptVersionRepository!.findMaxVersionNumber(template.id, tx)) + 1;

      await this.promptVersionRepository!.create(
        PromptVersionFactory.CreatePromptVersion({
          tenantId: template.tenantId,
          promptTemplateId: template.id,
          versionNumber: nextVersionNumber,
          content: dto.content,
          variables: (dto.variables ?? template.variables) as never,
          changeReason: dto.changeReason ?? null,
          changedBy: userId,
        }),
        tx,
      );

      template.content = dto.content;
      if (dto.variables !== undefined) template.variables = dto.variables as never;
      template.updatedBy = userId ?? undefined;
      await this.promptTemplateRepository!.update(template.id, template, tx);

      const moved = withMovedPin(graph, nodeId, nextVersionNumber);
      if (!moved) {
        // Unreachable given the binding lookup above; throwing inside the
        // callback aborts the transaction rather than persisting a version row
        // nothing points at.
        throw new BadRequestException(`Node '${nodeId}' could not be re-pinned.`);
      }
      entity.graph = moved as unknown as JsonValue;
      entity.updatedBy = userId ?? undefined;

      // CAS, not a bare `update`: the route is `@RequiresIfMatch()`-gated, so the
      // definition write must both re-check the version and ADVANCE it — a graph
      // rewrite that left `_version` (and therefore the ETag) untouched would let
      // a client blind-write the same validator again. Throwing from inside the
      // callback aborts the transaction, so a losing CAS rolls the version row
      // back rather than orphaning it.
      const saved = await this.workflowDefinitionRepository.updateWithVersion(id, entity, dto.expectedVersion ?? entity.version, tx);
      return { updated: saved, versionNumber: nextVersionNumber };
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        action: 'node-prompt-edit',
        nodeId,
        promptTemplateId: template.id,
        previousVersionNumber,
        versionNumber,
        minted: true,
      },
    });

    return {
      ...WorkflowDefinitionDtoMapper.toResponse(updated),
      promptVersionMinted: true,
      promptVersionNumber: versionNumber,
      previousPromptVersionNumber: previousVersionNumber,
    };
  }

  /**
   * The "new version available" surface (DD-11).
   *
   * PATH 2 — an edit made on the Prompt management screen — creates a version
   * and moves NO node's pin, which is exactly what stops a shared template from
   * silently changing every workflow that references it. The cost of that
   * guarantee is that a node can fall behind INVISIBLY, so this read is the
   * other half of the design rather than a convenience: it is what makes
   * "behind" a thing an admin can see and act on, per node.
   */
  async listPromptBindings(id: string): Promise<NodePromptBindingResponse[]> {
    if (!this.promptTemplateRepository || !this.promptVersionRepository) {
      throw new BadRequestException('The prompt plane is not available in this deployment.');
    }

    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const bindings = collectPromptBindings(entity.graph as unknown as WorkflowGraph);

    return Promise.all(
      bindings.map(async (binding) => {
        const template = await this.promptTemplateRepository!.findById(binding.promptTemplateId).catch(() => null);
        const owned = template && template.tenantId === entity.tenantId ? template : null;
        const latestVersionNumber = owned ? await this.promptVersionRepository!.findMaxVersionNumber(owned.id) : null;

        return {
          nodeId: binding.nodeId,
          nodeType: binding.nodeType,
          promptTemplateId: binding.promptTemplateId,
          promptTemplateName: owned?.name ?? null,
          pinnedVersionNumber: binding.pinnedVersionNumber,
          latestVersionNumber,
          // An UNPINNED node is not "behind": it deliberately follows the
          // template, which is the pre-DD-11 behaviour and a legitimate choice.
          // Reporting it as stale would train admins to ignore the signal.
          hasNewVersion: binding.pinnedVersionNumber !== null && latestVersionNumber !== null && latestVersionNumber > binding.pinnedVersionNumber,
        };
      }),
    );
  }

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
  /**
   * TASK-856 — refuse to clone a SYSTEM template that pins a catalog ROW the destination tenant
   * cannot resolve.
   *
   * A node may bind a prompt (`promptTemplateId`) or a document shape (`documentTemplateId`) by
   * row id. Neither `PromptTemplate` nor `DocumentTemplate` is a SYSTEM-shared read
   * (`tenant-scope.ts`), and both reach a tenant as PER-TENANT CLONES WITH DIFFERENT IDS
   * (`seed/07-prompt-template.ts`) — so copying a SYSTEM template's id into a tenant row
   * produces a reference that tenant can neither read nor repair from the Studio.
   *
   * We fail LOUDLY rather than take either alternative: stripping the binding silently mutates
   * a clinical graph, and copying it verbatim ships a broken reference that only surfaces later,
   * further from the person who could fix it. The message names the nodes so it is actionable.
   *
   * Own-tenant clones never reach this check — every id in the tenant's own graph is already the
   * tenant's, because it could not have resolved anything else to author it.
   *
   * No-op on the shipped platform default, whose generation node binds by `taskKey` and resolves
   * through the tenant -> SYSTEM cascade (`seed/21-workflow-definition.ts`) — which is what a
   * clonable template should do.
   */
  private assertNoUnresolvableCatalogBindings(graph: WorkflowGraph): void {
    const promptBound = collectPromptBindings(graph).map((binding) => binding.nodeId);
    const documentBound = (graph.nodes ?? [])
      .filter((node) => {
        const config = node.config as Record<string, unknown> | undefined;
        const templateId = config?.[DOCUMENT_TEMPLATE_ID_KEY];
        return typeof templateId === 'string' && templateId.length > 0;
      })
      .map((node) => node.id);

    const offenders = [...new Set([...promptBound, ...documentBound])];
    if (offenders.length === 0) return;

    throw new BadRequestException(
      `This platform template pins catalog rows that belong to the platform, not to your tenant (nodes: ${offenders.join(', ')}). ` +
        'Cloning it would copy references your tenant cannot resolve. Author an equivalent workflow and bind your own prompt or document template on those nodes.',
    );
  }

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

  /**
   * TASK-790 W3(a) (TASK-789 H-1) — resolve the rule set through `WorkflowValidatorService` so a
   * tenant's `WorkflowInvariantRule` rows actually participate.
   *
   * Before this, every call went straight to `validate()` against the bundled, code-owned DRAFT
   * catalogue, so the "a tenant may ADD strictness" capability `workflow-invariant-rule.prisma`'s
   * header documents could not affect a single validation however many rows existed. The
   * validator resolves SYSTEM ∪ tenant rows, applies the one-way-strictness merge, and stamps the
   * real `ruleSetVersion`.
   *
   * Delegating cannot introduce a new throw: the validator is TOTAL by its own contract
   * ("a validator that is not total is a validator that can be bypassed") — every failure path
   * inside it, including a repository throw, resolves to a `WF-INTERNAL` ERROR finding with
   * `ok: false`, never an exception and never `ok: true`.
   */
  private async validateGraph(graph: WorkflowGraph, paletteKey: string, tenantId: string): Promise<WorkflowValidationReport> {
    const report = this.workflowValidator
      ? await this.workflowValidator.validateGraph(tenantId, paletteKey, graph)
      : validate(
          graph,
          { paletteKey, registry: workflowNodeClassLookup },
          { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum() },
        );

    // TASK-847 F-32 — merged into the SAME report rather than reported through a second channel,
    // so the Studio maps a capability problem onto a canvas node exactly like every other
    // finding, and a draft save records it as authoring feedback long before publish refuses it.
    const capability = await this.hyperparameterCapabilityFindings(graph, tenantId);
    if (capability.length === 0) return report;

    return {
      ...report,
      ok: report.ok && !capability.some((finding) => finding.severity === 'ERROR'),
      findings: [...report.findings, ...capability],
    };
  }

  /**
   * TASK-847 finding F-32 — the gate the ticket built and never wired.
   *
   * `hyperparameterCapabilityProblems` is a PURE function: it compares what a node tuned against
   * what the bound configuration declares it accepts. TASK-847 could not call it because the
   * capability set is DATA — it comes off the `AiModel` row the node's `providerConfigRef`
   * resolves to — and that read lives outside a package with no database. This is that read.
   *
   * The severity split is the contract's and is preserved exactly: a DECLARED set that omits the
   * parameter is an ERROR (the platform KNOWS it will be dropped), and an ABSENT set is a WARNING
   * ("nobody profiled this configuration" is not evidence of non-support).
   *
   * Resolution is one call per tuned node, run concurrently, through
   * `IAiRoutingPolicyService.resolveGenerationCapabilities` — the plane that owns the tenant →
   * SYSTEM cascade. Nothing here re-derives it, and nothing here can reach the Global customer
   * tenant `50000000-…`.
   */
  private async hyperparameterCapabilityFindings(graph: WorkflowGraph, tenantId: string): Promise<WorkflowFinding[]> {
    const bindings = collectGenerationBindings(graph);
    if (bindings.length === 0 || !this.routingPolicyService) return [];
    const routingPolicyService = this.routingPolicyService;

    const resolved = await Promise.all(
      bindings.map(async (binding) => ({
        binding,
        // A resolution failure is an UNKNOWN capability set, never a failed publish — the
        // service already contracts not to throw, and this is the belt to that suspenders.
        capabilities: await routingPolicyService.resolveGenerationCapabilities(tenantId, binding.providerConfigRef).catch(() => undefined),
      })),
    );

    return resolved.flatMap(({ binding, capabilities }) =>
      hyperparameterCapabilityProblems(binding.generation, capabilities).map((problem) => ({
        ruleId: HYPERPARAMETER_CAPABILITY_RULE_ID,
        ruleClass: 'invariant' as const,
        severity: problem.severity,
        nodeId: binding.nodeId,
        path: `/config/generation/${problem.parameter}`,
        message: problem.message,
      })),
    );
  }

  /**
   * D-7 — the tenant's CURRENT context-schema pin, or `null`.
   *
   * Resolved through `getEffectiveBundle`, which owns the DEPARTMENT → TENANT discovery cascade
   * and the "a schema only participates when it is SERVABLE" rule. Re-deriving that here would
   * be a second, silently-diverging copy of a resolution the platform already has one answer for.
   *
   * Never throws: `getEffectiveBundle` returns nulls (not an error) for a tenant that has
   * configured no schema, and a lookup failure must not be the thing that fails a publish. A
   * `null` pin from here is an honest "this tenant pinned nothing" — which is exactly what D-7's
   * hardcoded `null` could not distinguish itself from.
   */
  private async resolveContextSchemaVersionId(): Promise<string | null> {
    if (!this.contextSchemaService) return null;
    const bundle = await this.contextSchemaService.getEffectiveBundle().catch(() => null);
    return bundle?.contextSchemaVersionId ?? null;
  }

  /**
   * D-7 — `policyBindings` describing THIS graph rather than a frozen empty constant.
   *
   * `promptTemplateRefs` reuses DD-11's `collectPromptBindings`, which reads the binding off ANY
   * node carrying `promptTemplateId` rather than a node-TYPE allow-list — so a generation node
   * added to the registry later is picked up here for free, instead of being silently omitted
   * from the compiled artifact.
   *
   * `documentTemplateRefs` (TASK-810 DD-2) is the same derivation over the SHAPE binding a
   * generation node carries in its own config (`documentTemplateId` + `documentVersionNumber`,
   * declared by `DOCUMENT_BINDING_PROPERTIES` in `node-config-schemas.ts`). It is read off ANY
   * node carrying the key, for the same reason `collectPromptBindings` is: a node-TYPE allow-list
   * silently misses the next generation node someone registers.
   *
   * UNPINNED bindings are dropped, not defaulted — for BOTH ref lists. The compiled shape requires
   * `versionNumber: integer >= 1` (the normative `compiled-config.schema.json` and both pydantic
   * models agree), so emitting `0` for "no pin" would hand the interpreter a pin onto a version
   * that cannot exist. Absent is the truthful encoding of "this node follows the template's
   * approved version".
   */
  private buildCompilerContext(
    entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'tenantId' | 'paletteKey'>,
    graph: WorkflowGraph,
    contextSchemaVersionId: string | null,
  ): CompilerContext {
    const promptTemplateRefs = collectPromptBindings(graph)
      .filter((binding) => binding.pinnedVersionNumber !== null)
      .map((binding) => ({ nodeId: binding.nodeId, templateId: binding.promptTemplateId, versionNumber: binding.pinnedVersionNumber as number }));

    // SORTED by nodeId, unlike `promptTemplateRefs` above, which predates this and follows
    // authoring order. `compiledConfig` is checksummed over its canonical JSON (array order
    // PRESERVED), and `fuzz.test.ts` asserts "shuffling node/edge arrays never changes the
    // checksum" — so a list that followed `graph.nodes` order would let a purely cosmetic
    // reorder in the authoring UI mint a different compiled checksum for the same workflow.
    // `nodeId` is unique within a graph, so the sort is total and deterministic.
    const documentTemplateRefs = (Array.isArray(graph.nodes) ? graph.nodes : [])
      .map((node) => {
        const config = (node.config ?? {}) as Record<string, unknown>;
        const templateId = config[DOCUMENT_TEMPLATE_ID_KEY];
        const pinned = config[DOCUMENT_VERSION_NUMBER_KEY];
        if (typeof templateId !== 'string' || templateId.length === 0) return null;
        if (typeof pinned !== 'number' || !Number.isInteger(pinned) || pinned < 1) return null;
        return { nodeId: node.id, templateId, versionNumber: pinned };
      })
      .filter((ref): ref is { nodeId: string; templateId: string; versionNumber: number } => ref !== null)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    // Distinct + SORTED: `compiledConfig` is checksummed over its canonical JSON, so an
    // order that followed node authoring order would make the same graph compile to two
    // different checksums depending on how the author happened to lay it out.
    const entitlementKeys = [
      ...new Set(
        (Array.isArray(graph.nodes) ? graph.nodes : [])
          .map((node) => WORKFLOW_NODE_REGISTRY[node.type]?.entitlementKey)
          .filter((key): key is string => typeof key === 'string' && key.length > 0),
      ),
    ].sort();

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
      policyBindings: { ...NON_DERIVABLE_POLICY_BINDINGS, promptTemplateRefs, documentTemplateRefs, contextSchemaVersionId, entitlementKeys },
      nodeInfo: registryNodeInfo,
    };
  }

  /** The engine gate: throws (400) if `compile()` cannot turn `graph` into a `CompiledWorkflowConfig`
   *  (a cycle, or a node type `WORKFLOW_NODE_REGISTRY` does not resolve). */
  private compileGraphOrThrow(
    entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'tenantId' | 'paletteKey'>,
    graph: WorkflowGraph,
    contextSchemaVersionId: string | null,
  ): CompiledWorkflowConfig {
    const result = compile(graph, this.buildCompilerContext(entity, graph, contextSchemaVersionId));
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
