import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentRepository,
  AiModelRepository,
  CoreDatabaseService,
  DocumentTemplateRepository,
  McpServerRepository,
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
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import {
  ACTION_CATALOGUE,
  buildPortableBundle,
  canonicalJson,
  compile,
  hasBlockingFindings,
  hyperparameterCapabilityProblems,
  nodeInfo as registryNodeInfo,
  portableBundleProblems,
  publishFindings,
  registryChecksum,
  TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
  validate,
  WORKFLOW_NODE_REGISTRY,
  workflowNodeClassLookup,
} from '@arcaai/workflow-contract';
import type {
  CompiledWorkflowConfig,
  CompilerContext,
  PortableBundleTenantKind,
  PublishAgentView,
  ResolvedTriggerContextSchema,
  ProviderGenerationCapabilities,
  WorkflowFinding,
  WorkflowGraph,
  WorkflowValidationReport,
} from '@arcaai/workflow-contract';
import { createHash } from 'node:crypto';
import {
  assertEqualTenants,
  BaseService,
  FetchResponse,
  isSuperAdmin,
  PaginatedQuery,
  withFormattedCountProps,
  withFormattedPaginatedProps,
} from '../../common';
import { PolicyEngine } from '../../authorization/policy.engine';
// TASK-885 — CONSUMED, never modified: `agentPromotion/**` is lane F's (TASK-884). The
// Global -> SYSTEM path is the existing cross-tenant promotion plus a publish, not a second
// implementation of promotion.
import { IAgentService } from '../agent/IAgentService';
import { IAgentPromotionService } from '../agentPromotion/IAgentPromotionService';
import type { IAgentPromotionService as IAgentPromotionServicePort } from '../agentPromotion/IAgentPromotionService';
// TASK-889 — the membership-bounded cross-tenant step (the counterpart to that service's
// ELEVATED one). Imported from the file, not the folder barrel, to keep this lane's dependency
// on `agentPromotion/**` exactly what lane G declared: the promotion port, plus this.
import { runInTenantContext } from '../agentPromotion/tenant-context';
import { EvalPromotionGateService } from '../eval/eval-promotion-gate.service';
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
  ImportWorkflowDefinitionRequest,
  NodePromptBindingResponse,
  NodePromptUpdateResponse,
  PaginatedWorkflowDefinitionResponse,
  PromoteWorkflowToSystemRequest,
  PromoteWorkflowToSystemResponse,
  PublishWorkflowDefinitionRequest,
  SandboxCompileResult,
  SyncWorkflowDefinitionRequest,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionBundle,
  WorkflowDefinitionResponse,
  WorkflowNodeRegistryResponse,
  WorkflowSyncResponse,
  WorkflowSyncTargetResponse,
} from './dto';
import { collectGenerationBindings, type NodeGenerationBindingRef } from './node-generation-binding';
import { collectPromptBindings, promptContentChecksum, withMovedPin } from './node-prompt-binding';
import {
  collectPortableReferences,
  collectRowReferences,
  referenceMapKey,
  toPortableGraph,
  toTenantGraph,
  type PortableReference,
  type RowReference,
} from './portable-graph';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import type { IAiRoutingPolicyService as IAiRoutingPolicyServicePort } from '../ai-routing-policy/IAiRoutingPolicyService';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { WorkflowDefinitionDtoMapper } from './workflow-definition.dto.mapper';

const WORKFLOW_DEFINITION_FILTER_MODEL = 'WorkflowDefinition';

/**
 * TASK-885 — the Global build tenant.
 *
 * `50000000-…` is a CUSTOMER TENANT that the platform admin uses as a build-and-test playground
 * (`00-project-context.md` §"The two reserved tenants are NOT two config tiers"). It is NEVER a
 * configuration tier and must never appear in a runtime cascade; it appears here only as the
 * declared SOURCE of the promote-into-SYSTEM path the owner named. Declared locally, following
 * `ServiceAccountService`'s `GLOBAL_PLAYGROUND_TENANT_ID` — there is no shared constant, and
 * exporting one would invite exactly the cascade use this comment forbids.
 */
const GLOBAL_PLAYGROUND_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/**
 * This service's half of `PORTABLE_BUNDLE_KINDS` (TASK-889). Declared as a constant so the export
 * builder and the import validator can never drift to two different literals — the defect the
 * shared envelope exists to prevent.
 */
const WORKFLOW_BUNDLE_KIND = 'workflow' as const;

/** Provenance for an export: which TIER authored it. A tenant id never travels in a bundle. */
function tenantKindOf(tenantId: string): PortableBundleTenantKind {
  if (tenantId === SYSTEM_TENANT_ID) return 'system';
  if (tenantId === GLOBAL_PLAYGROUND_TENANT_ID) return 'global';
  return 'tenant';
}

/** `WorkflowFinding.ruleId` `validate()` stamps when `workflowGraphProblems` short-circuits the
 *  rule catalogue (`validate().ts`) — the ONLY finding source that is always publish()/write-blocking. */
const SHAPE_FINDING_RULE_ID = 'WF-SHAPE';

/**
 * finding F-32 — the rule id every hyper-parameter capability finding carries.
 *
 * Distinct from the DRAFT rule catalogue so `publish()` can tell "a clinically-unreviewed rule
 * fired" (never blocking, decision #3) from "this graph tunes a parameter that reaches nothing"
 * (blocking) apart, exactly as `SHAPE_FINDING_RULE_ID` separates a malformed graph from both.
 */
const HYPERPARAMETER_CAPABILITY_RULE_ID = 'WF-CAP-001';

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Server-authored compile()/validate() metadata ( flow). Bumping either
 *  is a deliberate release event, not tenant-configurable — same posture as
 *  `WORKFLOW_NODE_REGISTRY`'s `critical`/`externalWrite` fields.
 */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };

/**
 * The two `policyBindings` fields that are NOT derivable from the graph.
 *
 * This constant used to carry all five, and every compile() passed it verbatim — which is what
 * D-7 recorded: a published graph pinned NOTHING. `contextSchemaVersionId`, `promptTemplateRefs`
 * and `entitlementKeys` are now derived per compile() (see `buildCompilerContext`), leaving only
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

/**
 * the two config keys a generation node carries its DOCUMENT-SHAPE binding in.
 *  Declared as schema properties by `DOCUMENT_BINDING_PROPERTIES` in `@arcaai/workflow-contract`'s
 *  `node-config-schemas.ts`; named here for the same reason `PROMPT_TEMPLATE_ID_KEY` is named in
 *  `node-prompt-binding.ts` — the derivation below reads raw node config, and a re-typed string
 *  literal is how the two sides drift apart.
 */
const DOCUMENT_TEMPLATE_ID_KEY = 'documentTemplateId';
const DOCUMENT_VERSION_NUMBER_KEY = 'documentVersionNumber';

/**
 * TASK-890 §3.4 — the graph's one mandatory entry node, where a workflow's context-schema
 * REFERENCE is authored. Named here for the reason the two keys above are: this file reads raw
 * node config, and a re-typed string literal is how two sides of a contract drift apart.
 */
const TRIGGER_NODE_TYPE = 'core.trigger';

/**
 * What `resolveTriggerContextSchema` answers. `undefined` (the whole value) means "nothing to
 * resolve" and is NOT the same as `{ failure }`, which means "a reference was authored and it
 * does not resolve in this tenant" — the first skips the publish check, the second IS the check.
 */
type TriggerContextSchemaResolution =
  | undefined
  | { resolved: ResolvedTriggerContextSchema; failure?: undefined }
  | { resolved?: undefined; failure: 'CONTEXT_SCHEMA_NOT_FOUND' | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' };

/** A plain object, or `undefined`. Local to the context-schema reference read below. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * the STT palette's own key, as authored on `WorkflowDefinition.paletteKey`. Not an
 *  enum in this package (`paletteKey` is a free string on the entity) — a single named constant
 *  so the publish()-time entitlement check below and any future STT-specific branch share one
 *  literal, never a re-typed `'stt'` string.
 */
const STT_PALETTE_KEY = 'stt';

/**
 * The entitlement capability key `mapQuotaCapabilityToHttp` keys its `startsWith('feature') ->
 *  403` branch off — matches `ResolvedFeatures.paletteStt`'s column name `featurePaletteStt`
 *  exactly, mirroring `PLATFORM_DEFAULT_CAPABILITY` in
 *  `ai-provider-connection/assert-provider-available.ts` (the "first ENFORCED boolean
 * entitlement" precedent Task 7 names).
 */
const PALETTE_STT_CAPABILITY = 'featurePaletteStt';

/** Whether ANY finding in a report is the hard shape-level short-circuit. When true, `validate()`
 *  evaluated NO rule-catalogue rules at all (`validate().ts`'s early return) — the report carries
 *  only structural-shape problems, always write/publish()-blocking. */
function reportIsShapeBroken(report: WorkflowValidationReport): boolean {
  return report.findings.some((finding) => finding.ruleId === SHAPE_FINDING_RULE_ID);
}

/**
 * `WorkflowDefinition` CRUD + the compile()/validate()/publish() lifecycle.
 *
 * See `IWorkflowDefinitionService` for the create/update()/validate()/publish() contract and why a
 * row IS a version. Two engines from `@arcaai/workflow-contract` are wired here, not one:
 *
 * - `compile()` is the ENGINE gate — a cycle or an unregistered node type is a genuine defect
 *   in the authored graph and is ALWAYS rejected (create/update()/publish() all 400 on it).
 * `validate()`'s `DRAFT_SUMMARIZATION_RULE_SET` ( 22 not-yet-clinically-reviewed
 *   rules, `status: 'DRAFT'` on every rule) is recorded on `validationReport` for visibility
 * but NEVER blocks a write — decision #3 ( Risks & Open Questions): wiring the
 *   engine is not the same as enforcing unreviewed clinical rules. The one exception is a
 *   MALFORMED graph (`workflowGraphProblems`), which `validate()` also short-circuits into —
 *   `reportIsShapeBroken` is how this service tells "genuinely broken" from "a DRAFT rule
 *   fired" apart, since both land in the same `report.findings` array.
 */
@Injectable()
export class WorkflowDefinitionService extends BaseService implements IWorkflowDefinitionService {
  private readonly logger = new Logger(WorkflowDefinitionService.name);

  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional() so unit fixtures can construct without it; production DI
    // (EntitlementsServiceModule) always supplies it.
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // optional for the same reason (unit-fixture construction); production DI
    // (WorkflowDefinitionServiceModule importing PipelineServiceModule) always supplies it. A
    // publish() of an `stt`-palette workflow with this undefined is a MISCONFIGURATION, not a
    // silently-skipped feature — see the doc comment on `compileSttPipelineIfNeeded` below.
    @Optional() private readonly sttPipelineCompiler?: SttPipelineCompilerService,
    // (a) — the rule-row resolver. `@Optional()` for the same reason as the two
    // above (unit-fixture construction); production DI always supplies it via
    // `WorkflowValidatorServiceModule`. When absent, `validateGraph` falls back to the bundled
    // code-owned DRAFT catalogue — the behaviour that was UNIVERSAL before this ticket, so the
    // fallback cannot be less safe than the previous state.
    @Optional() private readonly workflowValidator?: WorkflowValidatorService,
    // DD-11 — the prompt plane. Optional() + trailing so existing positional unit
    // fixtures keep their arity; production DI (WorkflowDefinitionServiceModule
    // importing CoreDatabaseModule) always supplies both. Absent ⇒ the two
    // prompt-binding surfaces below refuse rather than half-work.
    @Optional() private readonly promptTemplateRepository?: PromptTemplateRepository,
    @Optional() private readonly promptVersionRepository?: PromptVersionRepository,
    // D-7 — the tenant's context-schema pin. `@Optional()` + trailing for the same reason as
    // the four above (positional unit fixtures); production DI supplies it via
    // `ConsultationContextSchemaServiceModule`. Absent ⇒ the pin resolves to `null` and the
    // publish() still succeeds: an unpinned artifact is worse than a pinned one, but refusing to
    // publish() at all would be worse than both, and the graph-derived bindings do not need it.
    @Optional() @Inject(IConsultationContextSchemaService) private readonly contextSchemaService?: IConsultationContextSchemaServicePort,
    // the provider plane, for the hyper-parameter capability gate.
    // `@Optional()` + trailing for the same reason as the five above (positional unit fixtures);
    // production DI supplies it via `AiRoutingPolicyServiceModule`. Absent ⇒ no capability set
    // resolves, so every tuned node reports the UNKNOWN warning and publish() still succeeds —
    // which is the same posture as an unprofiled configuration, and strictly safer than a gate
    // that fails a publish() because its own dependency was missing.
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicyService?: IAiRoutingPolicyServicePort,
    // TASK-876 — the publish-time clamp on `core.agent.overrides.generation` resolves the bound
    // agent (ACTIVE published, [tenant, SYSTEM]) to its model row and reads the SAME capability
    // set `AgentService.capabilitiesOf` reads. `@Optional()` + trailing for the same reason as
    // every dependency above (positional unit fixtures); absent ⇒ the set is UNKNOWN (WARNING).
    @Optional() @Inject(AgentRepository) private readonly agentRepository?: AgentRepository,
    @Optional() @Inject(AiModelRepository) private readonly aiModelRepository?: AiModelRepository,
    // TASK-885 — the two remaining catalogues a node config can reference by ROW ID
    // (`documentTemplateId`, `tools[].mcpServerId`). `@Optional()` + trailing for the same reason
    // as every dependency above (positional unit fixtures); production DI supplies both via
    // `CoreDatabaseModule`. Absent ⇒ that reference kind cannot be resolved, which surfaces as a
    // refused export or a named 409 on import — never as a silently dropped binding.
    @Optional() @Inject(DocumentTemplateRepository) private readonly documentTemplateRepository?: DocumentTemplateRepository,
    @Optional() @Inject(McpServerRepository) private readonly mcpServerRepository?: McpServerRepository,
    // TASK-885 — the cross-tenant verbs. `@Optional()` + trailing for the same reason as every
    // dependency above; production DI supplies all three. Absent ⇒ the verb that needs one
    // refuses with a stated misconfiguration rather than half-working across a tenant boundary.
    @Optional() @Inject(IAgentPromotionService) private readonly agentPromotionService?: IAgentPromotionServicePort,
    @Optional() private readonly evalPromotionGate?: EvalPromotionGateService,
    @Optional() private readonly policyEngine?: PolicyEngine,
    // TASK-890 §3.5 — the per-agent facts the publish gate needs about each `core.agent` node's
    // referenced agent (declared variable names, bound context payload schema, generation
    // ranges). The gate is a PURE function in a package with no database, so a service resolves
    // them; `AgentService.publishAgentViews` is that resolution and this is its one caller.
    // `@Optional()` + trailing for the same reason as every dependency above (positional unit
    // fixtures); absent ⇒ the map is empty and the contract SKIPS the per-agent checks rather
    // than guessing — an unresolved slot is safe, a WRONG one would not be.
    // `AgentServiceModule` does not import this module, so this closes no cycle.
    @Optional() @Inject(IAgentService) private readonly agentService?: Pick<IAgentService, 'publishAgentViews'>,
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
    const baseReport = await this.validateGraph(graph, dto.paletteKey, tenantId);
    if (reportIsShapeBroken(baseReport)) {
      throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: baseReport.findings });
    }

    // TASK-890 — the publish gate runs here too, RECORDED and never refusing. Before this,
    // `create` reported the catalogue's verdict alone, so a graph the very next `validate()`
    // refused with ERRORs was stored with `ok: true` — a green draft the console could not act
    // on. A draft is still WRITTEN: authoring feedback belongs on the report, not in a 400.
    const triggerContextSchema = await this.resolveTriggerContextSchema(graph);
    const report = this.mergePublishGate(baseReport, await this.graphPublishFindings(graph, triggerContextSchema));

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
   * seed a NEW lineage from an existing definition. See
   * `IWorkflowDefinitionService.clone` for the contract; the two things worth reading in the
   * code below are WHERE the slug-collision check sits (inside the transaction, fused with the
   * version mint) and WHAT is deliberately not carried over from the source row.
   */
  async clone(
    sourceId: string,
    dto: CloneWorkflowDefinitionRequest,
    /**
     * TASK-890 §3.4 — the reference-set provenance stamped on a PROVISIONING copy
     * (`sourceTemplateSlug` + `templateLocked`), the pair `AsrPipeline`, `DocumentTemplate` and
     * `ConsultationContextSchema` already carry. Absent for an ordinary console clone, which is
     * a tenant's own fork and descends from nothing the platform will ever re-sync.
     */
    provenance?: { sourceTemplateSlug: string; templateLocked: boolean },
  ): Promise<WorkflowDefinitionResponse> {
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
        ...(provenance ? { sourceTemplateSlug: provenance.sourceTemplateSlug, templateLocked: provenance.templateLocked } : {}),
        createdBy: this.requestUserId ?? undefined,
      });

      // Every server-owned publish() column is left at its factory default: `compiledConfig` +
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

  /**
   * TASK-890 §3.4 (OD-H / OD-J) — the REFERENCE-SET copy of one SYSTEM workflow definition.
   *
   * A tenant is PROVISIONED with the platform's definitions rather than resolving them through
   * a SYSTEM tier at runtime: `WorkflowAssignmentService.resolve` already has no SYSTEM tier
   * (`workflow-assignment.service.ts` walks department → tenant → null), so a tenant that lacks
   * a definition behaves exactly as it does today — the legacy dispatch path — and a tenant that
   * has one owns it outright.
   *
   * The copy lands as a DRAFT, exactly as `clone` does. A definition that nobody in the tenant
   * has reviewed must not become the graph that serves its consultations; the tenant admin
   * publishes it when they mean to, and until then the assignment cascade correctly sees
   * nothing. MISSING-ONLY by slug.
   */
  async cloneFromSystem(slug: string, targetTenantId: string): Promise<{ definitionId: string; created: boolean }> {
    const templates = await this.workflowDefinitionRepository.findSystemTemplates(this.databaseService.baseClient);
    const source = templates.find((row) => row.slug === slug);
    if (!source) {
      throw new NotFoundException(`No PUBLISHED SYSTEM workflow definition '${slug}' to clone from.`);
    }

    return runInTenantContext(this.clsService, targetTenantId, async () => {
      const existing = await this.workflowDefinitionRepository.findMaxVersionNumber(targetTenantId, slug, this.databaseService.baseClient);
      if (existing > 0) {
        const rows = await this.workflowDefinitionRepository.findAllVersionsBySlug(targetTenantId, slug).catch(() => []);
        return { definitionId: rows[0]?.id ?? '', created: false };
      }
      const created = await this.clone(
        source.id,
        { targetSlug: source.slug, name: source.name, description: source.description ?? null } as CloneWorkflowDefinitionRequest,
        { sourceTemplateSlug: source.slug, templateLocked: true },
      );
      return { definitionId: created.id, created: true };
    });
  }

  // ============================================================
  // TASK-885 (owner #4) — import / export
  // ============================================================

  /**
   * Export ONE version as a portable bundle. VALUES ONLY — see
   * `WorkflowDefinitionBundlePayload` for the full "what never travels" table and
   * `portable-graph.ts` for how each row id becomes a portable key.
   *
   * A reference the graph makes that no longer RESOLVES is a 400, not a silent omission. The
   * alternative is an export that looks complete and imports as a workflow missing a prompt —
   * discovered later, by someone who did not author it. This is the same "fail LOUDLY rather
   * than strip or copy" call `assertNoUnresolvableCatalogBindings` makes on the clone path.
   */
  async exportDefinition(id: string): Promise<WorkflowDefinitionBundle> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const graph = this.parseGraphOrThrow(entity.graph as unknown as Record<string, unknown>);
    const keyById = await this.resolveRowReferenceKeys(collectRowReferences(graph), entity.tenantId);
    const portable = toPortableGraph(graph, keyById);

    if (portable.unresolved.length > 0) {
      throw new BadRequestException({
        message:
          'This workflow references rows that no longer resolve, so it cannot be exported without silently losing them. ' +
          'Repair the bindings on the named nodes and export again.',
        code: 'WORKFLOW_EXPORT_UNRESOLVED_REFERENCES',
        unresolvedReferences: portable.unresolved.map((reference) => ({ nodeId: reference.nodeId, kind: reference.kind })),
      });
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: entity.id,
      data: { action: 'export', slug: entity.slug, versionNumber: entity.versionNumber, references: portable.references.length },
    });

    // The envelope is BUILT by the shared contract, never assembled here: `schemaVersion` and
    // `exportedAt` are its business, and a hand-written literal is how two kinds of bundle end up
    // claiming two different envelope versions. The cast is the same one `AgentService.exportBySlug`
    // makes — `buildPortableBundle` returns the `kind` UNION, while the DTO narrows it for Swagger.
    const bundle = buildPortableBundle(
      WORKFLOW_BUNDLE_KIND,
      { tenantKind: tenantKindOf(entity.tenantId), slug: entity.slug, version: entity.versionNumber },
      {
        name: entity.name,
        description: entity.description ?? null,
        paletteKey: entity.paletteKey,
        graph: portable.graph as unknown as Record<string, unknown>,
        references: portable.references,
      },
    );
    return bundle as unknown as WorkflowDefinitionBundle;
  }

  /**
   * Import a bundle into the caller's tenant as a NEW DRAFT lineage.
   *
   * Three properties are the whole contract, and each one is a decision:
   *
   * 1. **Resolution is against the CALLER's visible catalogue**, never the bundle's. A bundle
   *    carries keys precisely so that the importing tenant's own prompt template of that name is
   *    what the node ends up bound to.
   * 2. **Unresolvable references refuse the WHOLE bundle**, naming every one, with a 409. Not a
   *    partial import (a workflow with a missing binding is a workflow that fails at run time,
   *    far from the person who could fix it) and not a silent drop. This deliberately differs
   *    from `IAiRoutingPolicyService.importConfigurations`, which SKIPS an unresolvable model:
   *    a routing artifact is a set of independent rows, while a graph is one artifact whose
   *    parts are not independently useful.
   * 3. **The report is recomputed and the row lands DRAFT.** Every publish artifact stays at its
   *    factory default, exactly as on the clone path — an import has been reviewed by nobody.
   */
  async importDefinition(dto: ImportWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    const { bundle } = dto;
    // ONE envelope check for BOTH bundle kinds (TASK-889). Wrong kind, unreadable schema version,
    // missing `source`, non-object payload — all of it is the shared contract's answer, so an
    // agent bundle POSTed here and a workflow bundle POSTed to the agent importer fail the same
    // way, with the same problem list naming the same paths.
    const envelopeProblems = portableBundleProblems(bundle, { kind: WORKFLOW_BUNDLE_KIND });
    if (envelopeProblems.length > 0) {
      throw new BadRequestException({
        message: 'This document is not a valid workflow bundle.',
        code: 'BUNDLE_INVALID',
        findings: envelopeProblems,
      });
    }

    // Byte-for-byte the precheck `create` and `clone` run: an import writes a row, so an import
    // path that skipped this would be a `maxWorkflowDefinitions` bypass with extra steps.
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.workflowDefinitionRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxWorkflowDefinitions', currentCount);
    }

    this.assertKnownPaletteKey(bundle.payload.paletteKey);

    const bundledGraph = this.parseGraphOrThrow(bundle.payload.graph);
    const { graph, unresolved } = await this.resolveBundleReferences(bundledGraph, tenantId);
    if (unresolved.length > 0) {
      throw new ConflictException({
        message:
          'This workflow references catalogue entries your tenant does not have. Create them (or import them first) and try again — ' +
          'nothing was imported.',
        code: 'WORKFLOW_IMPORT_UNRESOLVED_REFERENCES',
        unresolvedReferences: unresolved,
      });
    }

    const report = await this.validateGraph(graph, bundle.payload.paletteKey, tenantId);
    if (reportIsShapeBroken(report)) {
      throw new BadRequestException({ message: 'The imported workflow graph is not valid.', findings: report.findings });
    }

    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      // The collision check IS the version mint, read from the TX client — `clone`'s reasoning
      // verbatim: an import must never land as version N+1 of a lineage that may be published
      // and serving traffic.
      const maxVersionNumber = await this.workflowDefinitionRepository.findMaxVersionNumber(tenantId, dto.targetSlug, tx);
      if (maxVersionNumber > 0) {
        throw new ConflictException(
          `Slug '${dto.targetSlug}' is already in use by this tenant. Choose another slug, or open that workflow and create a new version of it instead.`,
        );
      }

      const entity = WorkflowDefinitionFactory.CreateDefinition({
        tenantId,
        slug: dto.targetSlug,
        name: dto.name ?? bundle.payload.name,
        description: bundle.payload.description ?? null,
        paletteKey: bundle.payload.paletteKey,
        versionNumber: maxVersionNumber + 1,
        parentVersionId: null,
        graph: graph as unknown as JsonValue,
        graphChecksum: graphChecksum(graph),
        validationReport: report as unknown as JsonValue,
        validatedAt: new Date(),
        createdBy: this.requestUserId ?? undefined,
      });

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
        importedFrom: bundle.source,
        importedAt: bundle.exportedAt,
      },
    });

    return WorkflowDefinitionDtoMapper.toResponse(saved);
  }

  /**
   * ROW ID -> portable key, for the four id-keyed reference kinds. One read per DISTINCT id.
   *
   * A read that throws (a deleted row, a row in another tenant) resolves to ABSENT rather than
   * propagating: the caller turns absence into the named 400, which says something an admin can
   * act on, where a raw `DataNotFoundException` would name a row id they have never seen.
   */
  private async resolveRowReferenceKeys(references: RowReference[], tenantId: string): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    await Promise.all(
      [...new Map(references.map((reference) => [referenceMapKey(reference.kind, reference.id), reference])).values()].map(async (reference) => {
        const key = await this.portableKeyFor(reference, tenantId);
        if (key) resolved.set(referenceMapKey(reference.kind, reference.id), key);
      }),
    );

    return resolved;
  }

  private async portableKeyFor(reference: RowReference, tenantId: string): Promise<string | null> {
    try {
      switch (reference.kind) {
        case 'promptTemplate':
          return (await this.promptTemplateRepository?.findById(reference.id))?.name ?? null;
        case 'documentTemplate':
          return (await this.documentTemplateRepository?.findById(reference.id))?.slug ?? null;
        case 'mcpServer':
          return (await this.mcpServerRepository?.findById(reference.id))?.name ?? null;
        case 'routingPolicy':
          return (await this.routingPolicyService?.getById(reference.id, tenantId))?.taskKey ?? null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Portable key -> this tenant's rows.
   *
   * The three REWRITTEN kinds are resolved into row ids by `toTenantGraph`; the three
   * already-portable kinds (`agent`, `model`, `routingTask`) are only VERIFIED — the graph keeps
   * the key, but importing a graph that names an agent this tenant cannot see would produce a
   * definition that fails at run time, so absence is an unresolved reference exactly like a
   * missing prompt template.
   */
  private async resolveBundleReferences(graph: WorkflowGraph, tenantId: string): Promise<{ graph: WorkflowGraph; unresolved: PortableReference[] }> {
    const references = collectPortableReferences(graph);

    const idByKey = new Map<string, string>();
    const verificationFailures: PortableReference[] = [];

    await Promise.all(
      [...new Map(references.map((reference) => [referenceMapKey(reference.kind, reference.key), reference])).values()].map(async (reference) => {
        const outcome = await this.resolveImportReference(reference, tenantId);
        if (outcome === null) {
          verificationFailures.push(reference);
          return;
        }
        if (outcome !== true) idByKey.set(referenceMapKey(reference.kind, reference.key), outcome);
      }),
    );

    const resolvedGraph = toTenantGraph(graph, idByKey);

    // Reported in AUTHORED NODE ORDER, not in resolution order — `Promise.all` settles
    // non-deterministically, and a 409 whose list reorders between two identical requests is a
    // 409 nobody can write a test against.
    const unresolvable = new Set(
      [...resolvedGraph.unresolved, ...verificationFailures].map((reference) => referenceMapKey(reference.kind, reference.key)),
    );

    return {
      graph: resolvedGraph.graph,
      unresolved: references.filter((reference) => unresolvable.has(referenceMapKey(reference.kind, reference.key))),
    };
  }

  /** `true` = verified in place, a string = the row id to rewrite to, `null` = unresolvable. */
  private async resolveImportReference(reference: PortableReference, tenantId: string): Promise<string | true | null> {
    try {
      switch (reference.kind) {
        case 'promptTemplate':
          return (await this.promptTemplateRepository?.findByName(tenantId, reference.key))?.id ?? null;
        case 'documentTemplate':
          return (await this.documentTemplateRepository?.findByTenantAndSlug(tenantId, reference.key))?.id ?? null;
        case 'mcpServer':
          return (await this.mcpServerRepository?.findByTenantAndName(tenantId, reference.key))?.id ?? null;
        case 'agent':
          return (await this.agentRepository?.findPublishedActiveBySlug(tenantId, reference.key)) ? true : null;
        case 'model':
          return (await this.aiModelRepository?.findBySlug(tenantId, reference.key)) ? true : null;
        case 'routingTask':
          // The elected default for the task key, on the tenant -> SYSTEM cascade. A tenant that
          // has VETOED the task (`TaskSelectionVetoedError`) is caught here and reported as
          // unresolvable, which is the honest answer: the import would produce a node that
          // fails closed at run time.
          return (await this.routingPolicyService?.resolveDefault(tenantId, reference.key)) ? true : null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  // ============================================================
  // TASK-885 (owner #4) — cross-tenant: sync, and Global -> SYSTEM
  // ============================================================

  /**
   * Sync ONE workflow version into other tenants the caller already manages.
   *
   * See `SyncWorkflowDefinitionRequest` for what distinguishes this from promotion. Three
   * properties are the contract:
   *
   * 1. **Authorization is per tenant, and it runs BEFORE any read.** `manage:WorkflowDefinition`
   *    in the source (missing ⇒ 403, a privilege the caller claimed) and in every target
   *    (missing ⇒ **404**, so a list of tenant ids can never be used to discover which tenants
   *    exist). The asymmetry is deliberate and is the owner's instruction.
   * 2. **The graph is made PORTABLE and re-resolved per target.** Copying it verbatim would
   *    write the SOURCE tenant's row ids into other tenants — the exact defect
   *    `assertNoUnresolvableCatalogBindings` refuses on the clone path. Every target resolves the
   *    portable keys against its OWN catalogue and recompiles against its OWN rule set.
   * 3. **All-or-nothing.** If ANY target cannot resolve a reference the whole sync is refused,
   *    naming the tenant and the references. A partial sync leaves an estate an admin cannot
   *    reason about, and the remedy — create the missing row — is the same either way.
   *
   * A target that already has the lineage gets the NEXT version of it, DRAFT and inactive. That
   * is what makes this a sync rather than a clone: the slug is the workflow's identity, and one
   * admin must never silently re-point another tenant's live consultations.
   *
   * ## TASK-889 — how a NON-elevated caller reaches the data
   *
   * This used to require the elevated tenant-less context `promoteToSystem` requires, which made
   * it unreachable for the very person owner #4 names: a multi-tenant CUSTOMER admin is not a
   * platform admin and must not be made one to copy their own workflow between their own
   * tenants. The gate is gone; what replaces it is not a widening but a NARROWING —
   * `runInTenantContext` runs each step under the ONE tenant that step means, so the
   * tenant-scope extension filters and asserts it exactly as it would an ordinary request. The
   * source read is pinned to the source, each target's resolve / validate / write to that
   * target, and nothing runs under a tenant that has not just passed the `manage` check above.
   * A super admin gains from this too: even elevated, each step is PINNED rather than passed
   * through, so a sync can never read the whole estate by accident.
   */
  async syncToTenants(slug: string, dto: SyncWorkflowDefinitionRequest): Promise<WorkflowSyncResponse> {
    const userId = this.requestUserId;
    if (!userId) throw new ForbiddenException('Syncing a workflow requires an authenticated user');
    if (!this.policyEngine) throw new Error('WorkflowDefinitionService.syncToTenants requires PolicyEngine (misconfiguration).');

    const targets = [...new Set(dto.targetTenantIds)];
    if (targets.includes(dto.sourceTenantId)) {
      throw new BadRequestException('A sync must target OTHER tenants; use the definition editor to create a new version in this one.');
    }

    // ---- Authorization, before any read (see property 1 above) -------------
    if (!(await this.managesWorkflowDefinitions(userId, dto.sourceTenantId))) {
      throw new ForbiddenException('Syncing requires manage:WorkflowDefinition on the source tenant.');
    }
    for (const targetTenantId of targets) {
      if (!(await this.managesWorkflowDefinitions(userId, targetTenantId))) {
        // 404, not 403: a 403 would confirm the tenant exists.
        throw new NotFoundException(`Tenant ${targetTenantId} was not found.`);
      }
    }

    // ---- The exact immutable source version, read AS the source tenant ------
    // Both reads here are the SOURCE's: the version row, and the catalogue rows its graph binds
    // by id. Pinning the step is what lets a caller whose working tenant is some OTHER tenant
    // they manage read it at all — and what stops an elevated caller reading it unfiltered.
    const { source, portable } = await runInTenantContext(this.clsService, dto.sourceTenantId, async () => {
      const version = await this.resolveVersionForTenant(dto.sourceTenantId, slug, dto.versionNumber);
      const graph = this.parseGraphOrThrow(version.graph as unknown as Record<string, unknown>);
      return {
        source: version,
        portable: toPortableGraph(graph, await this.resolveRowReferenceKeys(collectRowReferences(graph), dto.sourceTenantId)),
      };
    });
    if (portable.unresolved.length > 0) {
      throw new BadRequestException({
        message: 'This workflow references rows that no longer resolve in the source tenant, so it cannot be synced without losing them.',
        code: 'WORKFLOW_EXPORT_UNRESOLVED_REFERENCES',
        unresolvedReferences: portable.unresolved.map((reference) => ({ nodeId: reference.nodeId, kind: reference.kind })),
      });
    }

    // ---- Resolve + validate EVERY target before writing ANY of them --------
    const prepared: { tenantId: string; graph: WorkflowGraph; report: WorkflowValidationReport }[] = [];
    const unresolved: { tenantId: string; references: PortableReference[] }[] = [];

    for (const targetTenantId of targets) {
      // Both of these read the TARGET's catalogue — its prompt templates, its agents, its models,
      // its validation rules. Under the caller's own pinned tenant they would have answered for
      // the WRONG tenant (or thrown `TenantScope: tenantId mismatch`), which is precisely what
      // made this path super-admin-only before TASK-889.
      const outcome = await runInTenantContext(this.clsService, targetTenantId, async () => {
        const resolved = await this.resolveBundleReferences(portable.graph, targetTenantId);
        if (resolved.unresolved.length > 0) return { unresolved: resolved.unresolved };
        return { resolved: resolved.graph, report: await this.validateGraph(resolved.graph, source.paletteKey, targetTenantId) };
      });
      if (outcome.unresolved) {
        unresolved.push({ tenantId: targetTenantId, references: outcome.unresolved });
        continue;
      }
      if (reportIsShapeBroken(outcome.report!)) {
        throw new BadRequestException({
          message: `The workflow graph is not valid for tenant ${targetTenantId}.`,
          findings: outcome.report!.findings,
        });
      }
      prepared.push({ tenantId: targetTenantId, graph: outcome.resolved!, report: outcome.report! });
    }

    if (unresolved.length > 0) {
      throw new ConflictException({
        message: 'Some target tenants do not have the catalogue entries this workflow references. Nothing was synced.',
        code: 'WORKFLOW_SYNC_UNRESOLVED_REFERENCES',
        unresolved,
      });
    }

    // ---- One transaction for the whole estate ------------------------------
    const written = await this.databaseService.baseClient.$transaction(async (tx) => {
      const rows: WorkflowSyncTargetResponse[] = [];
      for (const target of prepared) {
        // The write, too, names its tenant — see `runInTenantContext` for why the TRANSACTION
        // itself stays on the unscoped client (version minting must see soft-deleted rows).
        rows.push(
          await runInTenantContext(this.clsService, target.tenantId, async () => {
            const maxVersionNumber = await this.workflowDefinitionRepository.findMaxVersionNumber(target.tenantId, slug, tx);
            const entity = WorkflowDefinitionFactory.CreateDefinition({
              tenantId: target.tenantId,
              slug,
              name: source.name,
              description: source.description ?? null,
              paletteKey: source.paletteKey,
              versionNumber: maxVersionNumber + 1,
              parentVersionId: null,
              graph: target.graph as unknown as JsonValue,
              graphChecksum: graphChecksum(target.graph),
              validationReport: target.report as unknown as JsonValue,
              validatedAt: new Date(),
              createdBy: this.requestUserId ?? undefined,
            });
            this.compileGraphOrThrow(entity, target.graph, null);
            const saved = await this.workflowDefinitionRepository.create(entity, tx);
            return {
              tenantId: target.tenantId,
              workflowDefinitionId: saved.id,
              slug: saved.slug,
              versionNumber: saved.versionNumber,
              findings: target.report.findings.map((finding) => `${finding.ruleId}: ${finding.message}`),
            };
          }),
        );
      }
      return rows;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: source.id,
      data: {
        action: 'sync',
        slug,
        sourceTenantId: dto.sourceTenantId,
        sourceVersionNumber: source.versionNumber,
        targets: written.map((row) => row.tenantId),
        ...(dto.changeReason ? { changeReason: dto.changeReason } : {}),
      },
    });

    return { slug, sourceVersionNumber: source.versionNumber, targets: written };
  }

  /**
   * Promote a workflow from the Global build tenant into SYSTEM, and PUBLISH it there.
   *
   * Owner #4: *the platform admin builds in Global and promotes into SYSTEM; SYSTEM is the
   * template every customer tenant refers to and the tenant template for new tenants; only the
   * platform admin manages SYSTEM.*
   *
   * ## This is the existing promotion plus a publish
   *
   * The cross-tenant copy is `IAgentPromotionService.promote` verbatim — the deep-copy of prompt
   * templates, the `evalGate` strip, the document-template block, the WORM audit record and the
   * "lands as a DRAFT" posture are all its behaviour, not a second implementation of it. What
   * this method adds is the half that promotion deliberately does NOT do: recompile the promoted
   * row against SYSTEM's own catalogue and PUBLISH it, because a SYSTEM template that stays a
   * draft is not a template.
   *
   * That extra step is safe here for the reason promotion refuses it in general: promotion runs
   * between two tenants neither of which the platform owns, and publishing into one of them
   * would re-point a customer's live consultations. SYSTEM owns no consultations. Publishing
   * there changes what a tenant WITH NO OPINION inherits, which is exactly the intent.
   *
   * ## The prior SYSTEM version stays as history
   *
   * `publishEntity` with `activate: true` demotes the previously-active version; it deletes
   * nothing. A `WorkflowDefinition` row IS a version, so SYSTEM's lineage keeps every template it
   * has ever published.
   *
   * ## The gate (owner #7)
   *
   * `EvalPromotionGateService.evaluateWorkflowPromotion` runs against the GLOBAL source and its
   * golden sets — the corpus never crosses a tenant boundary. Its default on this path is `warn`,
   * so a promotion is not blocked on evidence that does not exist yet; a platform admin who
   * writes `agentic.eval.promotionGate = block` gets a 409 back.
   *
   * @throws ForbiddenException — not a super admin, or the context is not elevated and tenant-less
   * @throws NotFoundException — Global has no such workflow
   * @throws ConflictException — the eval gate blocked (`EVAL_GATE_FAILED`)
   */
  async promoteToSystem(dto: PromoteWorkflowToSystemRequest): Promise<PromoteWorkflowToSystemResponse> {
    this.assertElevatedTenantlessContext('Promoting into SYSTEM');
    // A PRIVILEGE boundary (403), not the 404-over-403 cross-tenant posture: "only the platform
    // admin manages SYSTEM" is a statement about the actor, not about whether a row exists.
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Only a platform administrator may promote a workflow into the SYSTEM template library.');
    }
    if (!this.agentPromotionService) {
      throw new Error('WorkflowDefinitionService.promoteToSystem requires IAgentPromotionService (misconfiguration).');
    }

    const source = await this.resolveVersionForTenant(GLOBAL_PLAYGROUND_TENANT_ID, dto.sourceDefinitionSlug, dto.definitionVersionNumber);

    // TASK-930 §6.2 — before the eval gate, because it is cheaper and its failure is more
    // actionable: a graph naming an agent SYSTEM does not carry cannot run for ANY tenant
    // provisioned from it, whatever the evals say.
    await this.assertReferencedAgentsInSystem(source.graph as unknown as WorkflowGraph);

    // The gate runs BEFORE the promotion, so a block writes nothing at all.
    const verdict = (await this.evalPromotionGate?.evaluateWorkflowPromotion({
      tenantId: GLOBAL_PLAYGROUND_TENANT_ID,
      definitionSlug: source.slug,
      graph: source.graph,
    })) ?? { mode: 'off' as const, evaluated: false, passed: true, blocked: false, failures: [], runIds: [], aggregates: {} };

    if (verdict.blocked) {
      throw new ConflictException({
        message: 'The eval promotion gate failed for this workflow, and the gate is configured to block.',
        code: 'EVAL_GATE_FAILED',
        failures: verdict.failures,
        runIds: verdict.runIds,
        aggregates: verdict.aggregates,
      });
    }

    const promotion = await this.agentPromotionService.promote({
      sourceDefinitionSlug: source.slug,
      fromTenantId: GLOBAL_PLAYGROUND_TENANT_ID,
      toTenantId: SYSTEM_TENANT_ID,
      definitionVersionNumber: source.versionNumber,
      changeReason: dto.changeReason,
    });

    const targetId = promotion.targetDefinitionVersionId;
    if (!targetId) {
      throw new ConflictException('The promotion recorded no target definition row; nothing was published into SYSTEM.');
    }

    const promoted = await this.workflowDefinitionRepository.findById(targetId);
    const published = await this.publishEntity(promoted, { activate: true });

    return {
      promotionId: promotion.id,
      workflowDefinitionId: published.id,
      slug: published.slug,
      versionNumber: published.versionNumber,
      published: true,
      evalGateMode: verdict.mode,
      warnings: [...(promotion.warnings ?? []), ...verdict.failures, ...(verdict.warning ? [verdict.warning] : [])],
    };
  }

  /**
   * TASK-930 §6.2 — every `core.agent` node in the graph must name an agent SYSTEM already
   * carries as a PUBLISHED, ACTIVE row.
   *
   * ## Why this is a precondition of the promotion and not a warning on it
   *
   * A `core.agent` node binds an agent BY SLUG, and since TASK-890 OD-M a by-slug agent read no
   * longer widens to SYSTEM — a tenant resolves its OWN provisioned clone. So the SYSTEM
   * workflow this promotion publishes is the thing every future tenant is provisioned from, and
   * if SYSTEM has no agent of that slug there is nothing for the clone to be made of. The graph
   * is not degraded; it is unrunnable, and without this check it fails for the first clinician
   * to open a consultation rather than for the platform admin who caused it.
   *
   * ## Why 409, and why every slug at once
   *
   * The request is well-formed and the caller is entitled — what is not ready is the platform's
   * own state, which is a CONFLICT. And a promoter who has to fix one slug per 409 does the same
   * work five times, so `missing` carries them all. The hint names §6.1 because promoting the
   * agents is the fix.
   *
   * A graph with no `core.agent` node reads nothing and needs no repository — which is also why
   * the missing-dependency refusal below can be unconditional without breaking the agent-less
   * fixtures.
   */
  private async assertReferencedAgentsInSystem(graph: WorkflowGraph | null | undefined): Promise<void> {
    const slugs = new Set<string>();
    for (const node of graph?.nodes ?? []) {
      if (node.type !== 'core.agent') continue;
      const config = (node.config ?? {}) as { agentRef?: { slug?: unknown } };
      const slug = config.agentRef?.slug;
      if (typeof slug === 'string' && slug.length > 0) slugs.add(slug);
    }
    if (slugs.size === 0) return;

    if (!this.agentRepository) {
      // Loudly, not silently: skipping the gate would publish into SYSTEM the exact broken state
      // it exists to prevent, and the cause would be this method's own missing dependency.
      throw new Error('WorkflowDefinitionService.promoteToSystem requires AgentRepository to check the graph’s agent references (misconfiguration).');
    }

    const missing: string[] = [];
    for (const slug of [...slugs].sort()) {
      // SYSTEM, never the Global source: a Global-only agent does not make the SYSTEM copy runnable.
      const agent = await this.agentRepository.findPublishedActiveBySlug(SYSTEM_TENANT_ID, slug);
      if (!agent) missing.push(slug);
    }
    if (missing.length === 0) return;

    throw new ConflictException({
      message:
        `This workflow references ${missing.length === 1 ? 'an agent' : 'agents'} the SYSTEM reference set does not carry as a published, active version: ` +
        `${missing.join(', ')}. Promote ${missing.length === 1 ? 'it' : 'them'} first with POST admin/agents/promote-to-system, then retry.`,
      code: 'AGENTS_NOT_IN_SYSTEM',
      missing,
    });
  }

  /**
   * The applications-layer mirror of "the tenant-scope extension is in pass-through": no pinned
   * tenant in CLS. Stated as its own check for the reason `AgentPromotionService` gives — it
   * turns a raw `TenantScope: tenantId mismatch` 500, or a silently empty read taken for a 404,
   * into an actionable 403.
   *
   * This is NOT the authorization control; see the super-admin check in `promoteToSystem`.
   *
   * TASK-889: `syncToTenants` no longer calls this. Promotion is a PLATFORM action into the
   * SYSTEM tier and legitimately needs the unfiltered client; a sync is a sequence of ordinary
   * per-tenant steps a customer admin is separately entitled to, and it names its tenant per
   * step instead (`runInTenantContext`). Do not re-attach it to a membership-bounded caller.
   */
  private assertElevatedTenantlessContext(action: string): void {
    if (this.tenantId) {
      throw new ForbiddenException(
        `${action} crosses a tenant boundary and requires an elevated tenant-less context; clear the working tenant and retry.`,
      );
    }
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`${action} requires an elevated tenant-less context.`);
    }
  }

  /** Does this actor hold `manage:WorkflowDefinition` in that tenant? (`UserRoleAssignment` rows, through CASL.) */
  private async managesWorkflowDefinitions(userId: string, tenantId: string): Promise<boolean> {
    const ability = await this.policyEngine!.buildAbility({ userId, tenantId });
    return ability.can('manage', WORKFLOW_DEFINITION_FILTER_MODEL);
  }

  /**
   * The exact immutable version to move: an explicit `versionNumber`, else that tenant's ACTIVE
   * PUBLISHED row.
   *
   * Defaulting to ACTIVE PUBLISHED rather than the newest is `AgentPromotionService`'s call and
   * is repeated here on purpose: the newest row may be an unfinished draft, and pushing an
   * unvalidated graph across a tenant boundary is how this becomes a support ticket.
   */
  private async resolveVersionForTenant(tenantId: string, slug: string, versionNumber?: number): Promise<WorkflowDefinitionEntity> {
    if (versionNumber !== undefined) {
      const versions = await this.workflowDefinitionRepository.findAllVersionsBySlug(tenantId, slug);
      const match = versions.find((row) => row.versionNumber === versionNumber);
      if (!match) throw new NotFoundException(`Workflow '${slug}' has no version ${versionNumber} in tenant ${tenantId}.`);
      return match;
    }

    const published = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!published) {
      throw new NotFoundException(
        `Workflow '${slug}' has no ACTIVE PUBLISHED version in tenant ${tenantId}. Publish it there, or name an explicit version.`,
      );
    }
    return published;
  }

  /** the SYSTEM template library, read-only. */
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
  // Validate / publish()
  // ============================================================

  async validate(id: string): Promise<WorkflowDefinitionResponse> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });
    this.assertMutable(entity);

    const graph = entity.graph as unknown as WorkflowGraph;
    const baseReport = await this.validateGraph(graph, entity.paletteKey, entity.tenantId);
    // TASK-890 — the publish gate's findings are RECORDED here, never enforced: `validate()` is
    // authoring feedback, and refusing a draft for a problem publish will refuse anyway would
    // just move the same wall earlier in the author's day.
    const triggerContextSchema = await this.resolveTriggerContextSchema(graph);
    const publishGate = await this.graphPublishFindings(graph, triggerContextSchema);
    const report: WorkflowValidationReport = this.mergePublishGate(baseReport, publishGate);
    // Same bindings publish() will stamp — a validate() that compiled against different
    // policyBindings would greenlight an artifact the publish() then produces differently.
    const compileResult = compile(graph, this.buildCompilerContext(entity, graph, await this.resolveContextSchemaVersionId(), triggerContextSchema));
    // TASK-890 — a blocking PUBLISH finding also keeps the row a DRAFT. VALIDATED means
    // "publishable", and promoting a graph that `publish()` would then 400 on hands the console a
    // status it cannot act on. `validate()` still never THROWS — recording without refusing is
    // about the response, not about lying in the status column.
    const engineClean = !reportIsShapeBroken(report) && !('findings' in compileResult) && !hasBlockingFindings(publishGate);

    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    // DRAFT rule-catalogue findings never block this transition (decision #3) — only the
    // engine gate (shape + compile() + the publish gate) decides DRAFT -> VALIDATED.
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
    return this.publishEntity(entity, dto);
  }

  /**
   * The publish LIFECYCLE, with no tenant guard of its own.
   *
   * Split out by TASK-885 so the Global -> SYSTEM promotion can publish the SYSTEM row it just
   * created. That path runs under an ELEVATED TENANT-LESS context, where
   * `assertEqualTenants(entity, { tenantId: this.tenantId })` cannot mean anything — there is no
   * caller tenant to compare against, by design.
   *
   * Every caller of this method is therefore responsible for having established WHO may publish
   * THIS row before calling it: `publish()` does it with the tenant assertion above,
   * `promoteToSystem()` does it with a super-admin privilege check. The split is deliberate and
   * the guard is not optional — it moved, it did not disappear.
   */
  private async publishEntity(entity: WorkflowDefinitionEntity, dto: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    this.assertMutable(entity);
    await this.assertPaletteEntitled(entity);

    const graph = entity.graph as unknown as WorkflowGraph;
    const baseReport = await this.validateGraph(graph, entity.paletteKey, entity.tenantId);
    if (reportIsShapeBroken(baseReport)) {
      throw new BadRequestException({ message: 'The workflow graph is not valid.', findings: baseReport.findings });
    }

    // TASK-890 §3.5 — the publish gate. Runs AFTER the shape check (a malformed graph has
    // nothing coherent to check) and BEFORE compile and any entity mutation, so a refusal writes
    // nothing — the same discipline as the capability gate below it. WARNINGs
    // (`GUARDRAIL_OPTED_OUT`, and `PROMPT_VARIABLE_UNDECLARED` during the OD-C ramp) are recorded
    // and never block: an opt-out is a decision to record, not a defect to refuse.
    const triggerContextSchema = await this.resolveTriggerContextSchema(graph);
    const publishGate = await this.graphPublishFindings(graph, triggerContextSchema);
    const report: WorkflowValidationReport = this.mergePublishGate(baseReport, publishGate);
    if (hasBlockingFindings(publishGate)) {
      throw new BadRequestException({
        message: 'The workflow graph does not pass the publish gate.',
        findings: publishGate.filter((f) => f.severity === 'ERROR'),
      });
    }

    // the gate, at the moment it matters. A node that tunes a parameter its bound
    // provider configuration does not accept is refused HERE, at authoring time, rather than
    // having the value silently dropped on the wire during a clinical consultation. WARNING-level
    // capability findings (an unprofiled configuration) are recorded on the report and do NOT
    // block — "unknown" is not "unsupported", and blocking on it would gate the platform on data
    // entry. Runs BEFORE compile() and before any entity mutation, so a refusal writes nothing.
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
    const compiled = this.compileGraphOrThrow(entity, graph, await this.resolveContextSchemaVersionId(), triggerContextSchema);

    // an `stt`-palette publish() ALSO compiles the graph into an
    // `AsrPipeline`/`AsrPipelineVersion` row ( central design decision). Runs BEFORE
    // any entity mutation below: a failure here (e.g. no `stt.asrEngine` node) must abort the
    // publish() with nothing written, exactly like the engine gate above.
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
    // unrelated concurrent metadata edit must not 412 the publish().
    const updated = await this.workflowDefinitionRepository.update(entity.id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: entity.id,
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

  /**
   * The node PALETTE the Studio authors against: the eleven `core.*` node types AND the seventeen
   * `ACTION_CATALOGUE` entries a `core.action` may delegate to, in one sorted list keyed by type.
   *
   * TASK-893 Phase 4 — the actions are here because the client resolves a `core.action`
   * instance's effective ports by looking its `config.actionKey` up in the SAME map it builds
   * from this payload. They used to be node types, so the lookup found them for free; leaving
   * them out now makes every action instance fall back to `core.action`'s generic superset,
   * which draws sockets the action does not have and accepts wires it refuses — with no error.
   * The two vocabularies share one keyspace by construction (no action key is a node type).
   */
  async listNodes(): Promise<WorkflowNodeRegistryResponse> {
    const nodes = [
      ...Object.values(WORKFLOW_NODE_REGISTRY).map((descriptor) => WorkflowDefinitionDtoMapper.toNodeResponse(descriptor)),
      ...Object.values(ACTION_CATALOGUE).map((descriptor) => WorkflowDefinitionDtoMapper.toActionResponse(descriptor)),
    ];
    return {
      nodes: nodes.sort((a, b) => a.type.localeCompare(b.type)),
      registryChecksum: registryChecksum(),
    };
  }

  // ============================================================
  // Sandbox compile() ( Workbench — read, never a lifecycle transition)
  // ============================================================

  async getCompiledConfigForSandboxRun(id: string): Promise<SandboxCompileResult> {
    const entity = await this.workflowDefinitionRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const graph = entity.graph as unknown as WorkflowGraph;
    // The sandbox must preview exactly what publish() would stamp, bindings included — the
    // frozen trigger context schema among them.
    const compiledConfig = this.compileGraphOrThrow(
      entity,
      graph,
      await this.resolveContextSchemaVersionId(),
      await this.resolveTriggerContextSchema(graph),
    );

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

  /**
   * PUBLISHED/DEPRECATED rows are hard-immutable by SERVICE convention
   * (`workflow-definition.prisma`'s file header — modelled on
   *  `prompt-management.service.ts`'s `assertCanMutate`.
   */
  // ============================================================
  // DD-11 — prompt binding, and its two update() paths
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
   * Note that the `ConsultationContextSchema` publish() flow this ticket's
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

    // item 1 — ADOPT vs AUTHOR.
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
    //     (`ConsultationContextSchemaService.publish()`, and `approve`'s
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

      // CAS, not a bare `update()`: the route is `@RequiresIfMatch()`-gated, so the
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
   * The "new version available" surface.
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
   * (/D-5) — `paletteKey` must name a palette the node registry actually
   * declares. The DTO only constrains it to a string of at most 80 chars, and Workflow Studio's
   * palette field is a free-text `<Input>`, so a typo ('summarisation', 'Consultation') would
   * otherwise produce a row that is published-looking but permanently inert: `validate()` skips
   * every rule whose `paletteKey` does not match (`validate().ts`), so NO palette rule set ever
   * applies, and the Assignment Matrix has no column to offer it under.
   *
   * Create-only by design: `UpdateWorkflowDefinitionRequest` carries no `paletteKey`, so a
   * definition's palette is immutable after creation and there is no update() path to guard.
   *
   * The valid set is DERIVED from `WORKFLOW_NODE_REGISTRY` (see `KNOWN_PALETTE_KEYS`), never
   * re-typed here — a palette added to the registry is accepted with no edit to this service.
   */
  /**
   * refuse to clone a SYSTEM template that pins a catalog ROW the destination tenant
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
   * publish()-time-only entitlement gate, imitating
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
   * an `stt`-palette publish() compiles the graph into an `AsrPipeline` +
   * `AsrPipelineVersion` row ( No-op (`null`) for every other palette. When the
   * palette IS `stt` but `sttPipelineCompiler` was never wired, this is a deployment
   * misconfiguration, not a case to skip quietly — `WorkflowDefinitionServiceModule` always
   * supplies it in production; only unit fixtures construct without it (and none of them
   * publish() an `stt`-palette graph without also stubbing this).
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
   * (a) — resolve the rule set through `WorkflowValidatorService` so a
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
  /**
   * TASK-890 §3.5 (F-10, BLOCKER 1c) — the publish gate, at the ONE point that decides.
   *
   * `workflowPublishProblems` was a complete gate with zero callers, so a graph could be
   * published with a `core.agent` naming no agent, an unparseable CEL branch, or a node config
   * its own schema rejects, and the failure surfaced at RUN time — in a consultation. This is
   * that gate, wired: `publish()` refuses on an ERROR finding and `validate()` records the same
   * findings without refusing, so a draft gets the feedback long before anyone publishes it.
   *
   * `templateReferenceSeverity` comes from ONE contract constant (the OD-C ramp): today an
   * undeclared prompt variable is a WARNING, because no agent binds a context schema yet (gap
   * 4e) and enforcing it now would be a migration wearing a gate's clothes.
   *
   * Both per-agent slots are RESOLVED here — `triggerContextSchema` by L2's resolver and
   * `agents` by `AgentService.publishAgentViews` over the slugs this graph's `core.agent` nodes
   * name. Absent (no agent service wired, an unknown slug), a slot is simply not supplied and
   * the contract SKIPS that check rather than guessing: an unresolved slot is safe, a WRONG one
   * would not be. An unknown slug is already `AGENT_REF_MISSING` from the gate itself, so
   * inventing an empty view for it would mask a hard finding behind a soft one.
   */
  private async graphPublishFindings(graph: WorkflowGraph, triggerContextSchema?: TriggerContextSchemaResolution): Promise<WorkflowFinding[]> {
    const agents = await this.publishAgentViews(graph);
    return publishFindings(graph, {
      schemaValueProblems: jsonSchemaValueProblems,
      templateReferenceSeverity: TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
      ...(agents === undefined ? {} : { agents }),
      // `undefined` = not resolved, and the contract SKIPS the check. `null` = resolved to
      // nothing, which is the finding. The two are deliberately different values.
      ...(triggerContextSchema === undefined
        ? {}
        : triggerContextSchema.failure !== undefined
          ? { triggerContextSchema: null, triggerContextSchemaFailure: triggerContextSchema.failure }
          : { triggerContextSchema: triggerContextSchema.resolved?.payloadSchema ?? null }),
    });
  }

  /**
   * The agents this graph's `core.agent` nodes reference, resolved to what the publish gate
   * checks against. `undefined` when there is nothing to resolve or nobody to resolve it —
   * which the caller turns into an ABSENT slot, not an empty map.
   *
   * Best-effort by contract: a resolution failure must not fail a publish that is otherwise
   * clean. It degrades to "these checks were not run", which is the state every publish was in
   * before this wiring, rather than to a refusal whose cause is this method's own dependency.
   */
  private async publishAgentViews(graph: WorkflowGraph): Promise<Record<string, PublishAgentView> | undefined> {
    if (!this.agentService) return undefined;
    const slugs = new Set<string>();
    for (const node of graph.nodes ?? []) {
      if (node.type !== 'core.agent') continue;
      const config = (node.config ?? {}) as { agentRef?: { slug?: unknown } };
      const slug = config.agentRef?.slug;
      if (typeof slug === 'string' && slug.length > 0) slugs.add(slug);
    }
    if (slugs.size === 0) return undefined;
    try {
      return await this.agentService.publishAgentViews([...slugs]);
    } catch (error) {
      this.logger.warn({
        message: 'Per-agent publish-gate facts could not be resolved; the prompt-variable and override-range checks are skipped for this graph',
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async validateGraph(graph: WorkflowGraph, paletteKey: string, tenantId: string): Promise<WorkflowValidationReport> {
    const report = this.workflowValidator
      ? await this.workflowValidator.validateGraph(tenantId, paletteKey, graph)
      : validate(
          graph,
          { paletteKey, registry: workflowNodeClassLookup },
          { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum() },
        );

    // merged into the SAME report rather than reported through a second channel,
    // so the Studio maps a capability problem onto a canvas node exactly like every other
    // finding, and a draft save records it as authoring feedback long before publish() refuses it.
    const capability = await this.hyperparameterCapabilityFindings(graph, tenantId);
    if (capability.length === 0) return report;

    return {
      ...report,
      ok: report.ok && !capability.some((finding) => finding.severity === 'ERROR'),
      findings: [...report.findings, ...capability],
    };
  }

  /**
   * finding F-32 — the gate the ticket built and never wired.
   *
   * `hyperparameterCapabilityProblems` is a PURE function: it compares what a node tuned against
   * what the bound configuration declares it accepts. could not call it because the
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
    if (bindings.length === 0) return [];

    const resolved = await Promise.all(
      bindings.map(async (binding) => ({
        binding,
        // A resolution failure is an UNKNOWN capability set, never a failed publish() — the
        // service already contracts not to throw, and this is the belt to that suspenders.
        capabilities: await this.generationCapabilitiesFor(binding, tenantId).catch(() => undefined),
      })),
    );

    return resolved.flatMap(({ binding, capabilities }) =>
      hyperparameterCapabilityProblems(binding.generation, capabilities).map((problem) => ({
        ruleId: HYPERPARAMETER_CAPABILITY_RULE_ID,
        ruleClass: 'invariant' as const,
        severity: problem.severity,
        nodeId: binding.nodeId,
        path: `${binding.path}/${problem.parameter}`,
        message: problem.message,
      })),
    );
  }

  /**
   * The capability set that bounds one binding. A legacy `providerConfigRef` resolves through the
   * routing plane (tenant → SYSTEM cascade, `IAiRoutingPolicyService`); a TASK-876 `agentRef`
   * resolves through the AGENT — the PINNED version when the node names one, else its ACTIVE
   * published version, visible to the tenant — then its
   * model row's `_metadata.capabilities.supportedGenerationParams`, exactly the read
   * `AgentService.capabilitiesOf` makes when the agent itself is published — so the two gates
   * cannot disagree. `undefined` = unknown (WARNING); the runtime fails closed on an
   * unresolvable agent regardless.
   */
  private async generationCapabilitiesFor(binding: NodeGenerationBindingRef, tenantId: string): Promise<ProviderGenerationCapabilities | undefined> {
    if (binding.agentRef) {
      if (!this.agentRepository || !this.aiModelRepository) return undefined;
      // A PINNED `agentRef.versionNumber` names the version this node will actually run
      // (`TextAgentResolverService` refuses any other, 409). Reading the ACTIVE version instead
      // would clamp against a capability set the node never sees — and LABEL the finding with a
      // version number the author did not write. An unresolvable pin is an unknown capability
      // set (WARNING), the same as an unresolvable slug.
      const pin = binding.agentRef.versionNumber;
      const agent =
        typeof pin === 'number'
          ? await this.agentRepository.findPublishedVisibleBySlugVersion(tenantId, binding.agentRef.slug, pin)
          : await this.agentRepository.findPublishedActiveBySlug(tenantId, binding.agentRef.slug);
      const modelId = (agent?.compiledConfig as { model?: { id?: unknown } } | null)?.model?.id;
      if (!agent || typeof modelId !== 'string') return undefined;
      const model = await this.aiModelRepository.findById(modelId).catch(() => null);
      if (!model) return undefined;
      const meta = asPlainObject(model.metaData) ?? {};
      const caps = asPlainObject(meta.capabilities) ?? meta;
      const supported = Array.isArray(caps.supportedGenerationParams) ? (caps.supportedGenerationParams as string[]) : undefined;
      return {
        supportedGenerationParams: supported,
        label: `agent ${agent.slug} v${agent.versionNumber} → ${model.provider ?? 'local'}/${model.slug}`,
      };
    }
    if (!this.routingPolicyService || !binding.providerConfigRef) return undefined;
    return this.routingPolicyService.resolveGenerationCapabilities(tenantId, binding.providerConfigRef);
  }

  /**
   * D-7 — the tenant's CURRENT context-schema pin, or `null`.
   *
   * Resolved through `getEffectiveBundle`, which owns the DEPARTMENT → TENANT discovery cascade
   * and the "a schema only participates when it is SERVABLE" rule. Re-deriving that here would
   * be a second, silently-diverging copy of a resolution the platform already has one answer for.
   *
   * Never throws: `getEffectiveBundle` returns nulls (not an error) for a tenant that has
   * configured no schema, and a lookup failure must not be the thing that fails a publish(). A
   * `null` pin from here is an honest "this tenant pinned nothing" — which is exactly what D-7's
   * hardcoded `null` could not distinguish itself from.
   */
  private async resolveContextSchemaVersionId(): Promise<string | null> {
    if (!this.contextSchemaService) return null;
    const bundle = await this.contextSchemaService.getEffectiveBundle().catch(() => null);
    return bundle?.contextSchemaVersionId ?? null;
  }

  /**
   * TASK-890 §3.4 — resolve the trigger's context-schema REFERENCE, once per lifecycle call.
   *
   * Returns THREE distinguishable states, because the publish gate and the compiler need
   * different halves of the answer and conflating them is exactly how a dangling reference
   * would reach a run:
   *
   *  - `undefined` — nothing to resolve (no trigger, no reference, or no schema service wired).
   *    The gate SKIPS the check rather than guessing, which is why an unresolved slot is safe;
   *  - `{ resolved }` — the derived payload schema, frozen into the artifact by the compiler;
   *  - `{ failure }` — the reference did not resolve IN THIS TENANT. A blocking finding, named:
   *    a schema is CLONED into a tenant and never shared from SYSTEM (OD-H), so a SYSTEM or
   *    foreign id is simply invisible here, and "the version does not exist" is a different
   *    remedy from "the schema does not exist".
   */
  private async resolveTriggerContextSchema(graph: WorkflowGraph): Promise<TriggerContextSchemaResolution> {
    if (!this.contextSchemaService) return undefined;

    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const trigger = nodes.find((node) => node.type === TRIGGER_NODE_TYPE);
    const contextSchema = asRecord(trigger?.config)?.contextSchema;
    const reference = asRecord(contextSchema);
    const schemaId = typeof reference?.contextSchemaId === 'string' ? reference.contextSchemaId : '';
    // An INLINE schema is already the definition — there is nothing to look up, and the
    // compiler leaves it exactly as authored.
    if (schemaId.length === 0) return undefined;

    const versionNumber = typeof reference?.versionNumber === 'number' ? reference.versionNumber : undefined;
    const resolution = await this.contextSchemaService.resolveReference(schemaId, versionNumber);
    if (resolution.outcome === 'failed') return { failure: resolution.failure };

    return {
      resolved: {
        schemaId: resolution.schemaId,
        versionNumber: resolution.versionNumber,
        versionId: resolution.versionId,
        payloadSchema: resolution.payloadSchema,
      },
    };
  }

  /**
   * Fold the publish gate's findings into a rule-catalogue report.
   *
   * ONE helper, used by `create()`, `validate()` and `publishEntity()`, because they used to
   * disagree: `create` recorded only the catalogue's verdict, so a graph the very next
   * `validate()` refused was stored with `ok: true` — a green draft the console could not act
   * on. Recording is not refusing: whether a blocking finding also THROWS is the caller's
   * decision, and only `publishEntity` makes it.
   */
  private mergePublishGate(baseReport: WorkflowValidationReport, publishGate: WorkflowFinding[]): WorkflowValidationReport {
    if (publishGate.length === 0) return baseReport;
    return { ...baseReport, ok: baseReport.ok && !hasBlockingFindings(publishGate), findings: [...baseReport.findings, ...publishGate] };
  }

  /**
   * D-7 — `policyBindings` describing THIS graph rather than a frozen empty constant.
   *
   * `promptTemplateRefs` reuses DD-11's `collectPromptBindings`, which reads the binding off ANY
   * node carrying `promptTemplateId` rather than a node-TYPE allow-list — so a generation node
   * added to the registry later is picked up here for free, instead of being silently omitted
   * from the compiled artifact.
   *
   * `documentTemplateRefs` is the same derivation over the SHAPE binding a
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
    triggerContextSchema?: TriggerContextSchemaResolution,
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
    // order that followed node authoring order would make the same graph compile() to two
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
      // Only a RESOLVED reference is frozen. An unresolvable one never reaches compile: it is
      // a blocking publish finding first.
      ...(triggerContextSchema?.resolved ? { triggerContextSchema: triggerContextSchema.resolved } : {}),
      nodeInfo: registryNodeInfo,
    };
  }

  /** The engine gate: throws (400) if `compile()` cannot turn `graph` into a `CompiledWorkflowConfig`
   *  (a cycle, or a node type `WORKFLOW_NODE_REGISTRY` does not resolve). */
  private compileGraphOrThrow(
    entity: Pick<WorkflowDefinitionEntity, 'id' | 'slug' | 'versionNumber' | 'tenantId' | 'paletteKey'>,
    graph: WorkflowGraph,
    contextSchemaVersionId: string | null,
    triggerContextSchema?: TriggerContextSchemaResolution,
  ): CompiledWorkflowConfig {
    const result = compile(graph, this.buildCompilerContext(entity, graph, contextSchemaVersionId, triggerContextSchema));
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
