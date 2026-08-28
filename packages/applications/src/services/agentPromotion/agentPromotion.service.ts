import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  AgentPromotionEntity,
  AgentPromotionFactory,
  AgentPromotionRepository,
  ConsultationRepository,
  ConsultationStatus,
  CoreUnitOfWorkService,
  CorePrisma,
  DocumentTemplateRepository,
  PromptTemplateFactory,
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
import { canonicalJson, type WorkflowGraph, type WorkflowGraphNode } from '@arcaai/workflow-contract';
import { IAgentPromotionService } from './IAgentPromotionService';
import { AgentPromotionResponse, PaginatedAgentPromotionResponse, PromoteWorkflowRequest } from './dto';
import { AgentPromotionDtoMapper } from './agentPromotion.dto.mapper';
import { EvalRunService } from '../eval/eval-run.service';
import { PolicyEngine } from '../../authorization/policy.engine';
import { isSuperAdmin } from '../../common/tenant-guards';
import { BaseService, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

/**
 * The alert wording is asserted by tests and surfaced verbatim by the console,
 * so it lives in exactly one place.
 */
export function liveConsultationsWarning(count: number): string {
  const plural = count === 1 ? 'consultation is' : 'consultations are';
  return `${count} ${plural} currently running on the previous version and will complete on it.`;
}

/** The CASL subject this service authorizes against, in both tenants. */
const PROMOTION_SUBJECT = 'WorkflowDefinition';

/** Node config keys the promotion rewrites or strips. */
const PROMPT_TEMPLATE_ID_KEY = 'promptTemplateId';
const PROMPT_VERSION_NUMBER_KEY = 'promptVersionNumber';
const DOCUMENT_TEMPLATE_ID_KEY = 'documentTemplateId';
const EVAL_GATE_KEY = 'evalGate';

/**
 * Promote a workflow-definition version from one tenant to another.
 *
 * ## What is promoted (TASK-815 / OD-10)
 *
 * The promotable used to be a `DepartmentAgentVersion.configSnapshot`. With
 * `DepartmentAgent` retired, the thing a platform admin actually wants to move
 * between tenants is the AUTHORED WORKFLOW: its graph, its node configuration,
 * and the prompt templates its generation nodes bind. `WorkflowDefinition` rows
 * ARE versions (one row per `(tenantId, slug, versionNumber)`), so the exact
 * artifact promoted is one immutable row — the same discipline as before, and
 * the same discipline the repo's own `promote-*` CI jobs use when they re-tag a
 * digest rather than rebuild.
 *
 * ## Authorization is the entire control
 *
 * There is no platform environment, tier or tenant-family concept, so "the
 * actor holds `manage` on `WorkflowDefinition` in BOTH tenants" is all that
 * constrains which tenants may be promoted between. It is enforced in
 * `assertManagesBothTenants` and it runs BEFORE any read, so a caller who has
 * not proven it cannot use a 403/404 difference as an existence oracle over
 * either tenant's data.
 *
 * ## Tenant context
 *
 * `promote` runs under an ELEVATED TENANT-LESS context. That is a MECHANICAL
 * requirement, not a second authorization control: with a pinned tenant the
 * tenant-scope Prisma extension forces the caller's `tenantId` into every read,
 * which makes a cross-tenant read impossible rather than merely unauthorized.
 * The corollary matters when reading this file — in pass-through mode the
 * extension injects NOTHING, so **every repository call below passes `tenantId`
 * explicitly**. A missing filter here reads across all tenants.
 *
 * ## What is copied, and what is deliberately not
 *
 * Promotion copies VALUES, never REFERENCES. A reference — a template id, a
 * golden-set id — is meaningful only inside the tenant that owns it:
 *
 * | Node config | Treatment |
 * |---|---|
 * | `promptTemplateId` | DEEP-COPIED into the target and rewritten, unless it is SYSTEM-owned (genuinely readable cross-tenant) |
 * | `promptVersionNumber` | DROPPED with the copy — the target's fresh template starts at v1, so a source pin numbers a version that does not exist here |
 * | `evalGate` | STRIPPED. `goldenSetId` names a corpus of Vault-Transit-encrypted `GoldenCase` PHI; not even the pointer crosses a tenant boundary. The target re-binds its own gate |
 * | `documentTemplateId` | BLOCKS the promotion when tenant-owned. A `DocumentTemplate` is a shape with its own version lineage, and silently promoting a dangling reference would restructure the clinical document the target produces |
 *
 * ## The promoted row lands as a DRAFT
 *
 * Never PUBLISHED, never `isActive`. A cross-tenant push must not silently
 * become the workflow that governs another tenant's live consultations — the
 * same posture the agent promotion had when it pointedly refused to re-point
 * the target department's default agent. The target's own admin publishes it
 * through the existing validate/compile/publish path, which is also why this
 * service does not recompile: `compiledConfig` is server-owned output of that
 * path, and a second implementation of it would be a second thing to keep in
 * step with the node registry.
 *
 * ## Atomicity
 *
 * Everything promotion writes into the TARGET tenant — the deep-copied prompt
 * templates, the definition row, and the `AgentPromotion` audit record —
 * commits inside ONE `runInTransaction`. The eval re-run and the `evalRunId`
 * write that follows it stay OUTSIDE: the eval is an external, long-running
 * call, and holding a Postgres transaction open across it would be a worse
 * defect than the partial-promotion window being closed.
 *
 * ## The column names on `AgentPromotion` are older than what they hold
 *
 * The table is WORM and pre-dates this ticket, so its four id columns keep the
 * names they were created with. What they now carry:
 *
 * | Column | Now holds |
 * |---|---|
 * | `sourceAgentId` | the source definition's SLUG — its identity across versions |
 * | `agentVersionId` | the source definition ROW id: the exact version promoted |
 * | `targetAgentId` | the target definition's SLUG |
 * | `targetAgentVersionId` | the target definition ROW id this promotion created |
 *
 * The API surface (`PromoteWorkflowRequest` / `AgentPromotionResponse`) names
 * them for what they are; only the physical columns lag, and renaming them is a
 * migration with no behavioural content that this ticket deliberately did not
 * take on.
 */
@Injectable()
export class AgentPromotionService extends BaseService implements IAgentPromotionService {
  private readonly logger = new Logger(AgentPromotionService.name);

  constructor(
    private readonly promotionRepository: AgentPromotionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly definitionRepository: WorkflowDefinitionRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly documentTemplateRepository: DocumentTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly policyEngine: PolicyEngine,
    // The DOMAINS `CoreUnitOfWorkService`, not the identically named unwired
    // class under `services/baseServices`. REQUIRED, not optional: promotion is
    // a privileged cross-tenant write, and degrading silently to a
    // non-transactional sequence when the dependency is unwired would
    // reintroduce exactly the partial-promotion window this closes.
    private readonly unitOfWork: CoreUnitOfWorkService,
    @Optional() @Inject(EvalRunService) private readonly evalRunService?: EvalRunService,
  ) {
    super(eventEmitter, clsService, ResourceType.AgentPromotion);
  }

  // =========================================================================
  // Reads — ORDINARY tenant-scoped, by the target tenant that owns the record
  // =========================================================================

  async list(query: PaginatedQuery, targetDefinitionSlug?: string): Promise<PaginatedAgentPromotionResponse> {
    const tenantId = this.requireTenant();

    const where: Record<string, unknown> = { tenantId };
    if (targetDefinitionSlug) where.targetAgentId = targetDefinitionSlug;

    const rows = await this.promotionRepository.findAll({
      ...withFormattedPaginatedProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters is a structural record; this is a plain tenant/slug filter the repository accepts as-is.
      where: where as any,
      sort: [{ createdAt: 'desc' }],
    });
    const count = await this.promotionRepository.count({
      ...withFormattedCountProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same plain filter as the paginated read above.
      where: where as any,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count } });

    const { limit, page } = query;
    const data = await Promise.all(rows.map((row) => this.toResponseWithDrift(row)));
    return new PaginatedAgentPromotionResponse({ page: page ?? 0, limit: limit ?? 0, count, data });
  }

  async getById(id: string): Promise<AgentPromotionResponse> {
    const tenantId = this.requireTenant();
    const promotion = await this.promotionRepository.findById(id);
    // 404-over-403: a cross-tenant promotion id is "not yours", indistinguishable
    // from "missing".
    if (!promotion || promotion.tenantId !== tenantId) {
      throw new NotFoundException(`Workflow promotion ${id} not found`);
    }
    return this.toResponseWithDrift(promotion);
  }

  // =========================================================================
  // Promote — ELEVATED TENANT-LESS context
  // =========================================================================

  async promote(dto: PromoteWorkflowRequest): Promise<AgentPromotionResponse> {
    const { fromTenantId, toTenantId, sourceDefinitionSlug } = dto;

    // ---- 1. Mechanical precondition (see the class header) ----------------
    this.assertElevatedTenantlessContext();

    const userId = this.requestUserId;
    if (!userId) {
      throw new ForbiddenException('Promotion requires an authenticated user');
    }

    if (fromTenantId === toTenantId) {
      throw new BadRequestException('A promotion must target a DIFFERENT tenant; use the definition editor to copy within one tenant');
    }

    // ---- 2. THE authorization control, BEFORE any read --------------------
    await this.assertManagesBothTenants(userId, fromTenantId, toTenantId);

    // ---- 3. The exact immutable source version ----------------------------
    const source = await this.resolveSourceVersion(fromTenantId, sourceDefinitionSlug, dto.definitionVersionNumber);
    const sourceGraph = readGraph(source.graph);
    if (!sourceGraph) {
      throw new BadRequestException(`Workflow '${sourceDefinitionSlug}' version ${source.versionNumber} has no readable graph to promote`);
    }

    // ---- 4. Blocking gate -------------------------------------------------
    await this.assertNoTenantOwnedDocumentTemplates(sourceGraph);

    // ---- 5. Non-blocking alert -------------------------------------------
    const existingVersions = await this.definitionRepository.findAllVersionsBySlug(toTenantId, sourceDefinitionSlug);
    const warnings = await this.buildWarnings(toTenantId, existingVersions.length > 0);

    // ---- 6 + 7. The copy and its immutable record — ONE transaction -------
    // Everything the promotion produces in the TARGET tenant — the deep-copied
    // prompt templates, the definition row, and the `AgentPromotion` audit
    // record — commits or rolls back together. A repository caches its database
    // context at construction, so the CLS propagation inside `runInTransaction`
    // would NOT reach these singletons on its own: passing `tx` explicitly is
    // what actually enrols each write.
    const { targetDefinition, savedPromotion, checksum } = await this.unitOfWork.runInTransaction(async (tx: CorePrisma.TransactionClient) => {
      const promotedGraph = await this.materializeGraph(sourceGraph, source, toTenantId, userId, tx);
      const promotedChecksum = graphChecksum(promotedGraph);

      const definition = await this.writeTargetDefinition(source, promotedGraph, promotedChecksum, existingVersions, toTenantId, userId, tx);

      const promotion = AgentPromotionFactory.CreateAgentPromotion({
        fromTenantId,
        toTenantId,
        // See the class header for what these four columns now carry.
        agentVersionId: source.id,
        sourceAgentId: source.slug,
        targetAgentId: definition.slug,
        targetAgentVersionId: definition.id,
        configSnapshot: promotedGraph as never,
        checksum: promotedChecksum,
        sourceEvalRunId: dto.sourceEvalRunId ?? null,
        warnings: warnings as never,
        promotedBy: userId,
        createdBy: userId,
        metaData: dto.changeReason ? { changeReason: dto.changeReason } : undefined,
      } as never);
      promotion.validate();

      return {
        targetDefinition: definition,
        savedPromotion: await this.promotionRepository.create(promotion, tx),
        checksum: promotedChecksum,
      };
    });

    // Announced only AFTER the commit — a sys-event for a promotion that rolled
    // back would be a claim about something that never happened, which is the
    // failure mode the audit row exists to prevent.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedPromotion.id,
      createdAt: savedPromotion.createdAt,
      data: {
        // The event's own `tenantId` is CLS-sourced (a BaseService security
        // boundary) and is empty on this elevated path, so BOTH tenants travel
        // in the payload.
        fromTenantId,
        toTenantId,
        sourceDefinitionSlug: source.slug,
        sourceDefinitionVersionId: source.id,
        targetDefinitionVersionId: targetDefinition.id,
        checksum,
      },
    });

    // ---- 8. Eval RE-RUNS at the target, against the TARGET's corpus -------
    const evalRunId = await this.runTargetEval(dto, targetDefinition, toTenantId, warnings);
    if (evalRunId) {
      savedPromotion.evalRunId = evalRunId;
      await this.promotionRepository.update(savedPromotion.id, savedPromotion);
    }

    return AgentPromotionDtoMapper.toResponse(savedPromotion, false);
  }

  // =========================================================================
  // Guards
  // =========================================================================

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }

  /**
   * The applications-layer mirror of "the tenant-scope extension is in
   * pass-through": no pinned tenant in CLS, and an elevated actor.
   *
   * Checking it explicitly turns what would otherwise be a raw
   * `TenantScope: tenant context required` 500 — or, worse, a silently empty
   * result read as 404 — into a clear, actionable 403. This is NOT the
   * authorization control; see `assertManagesBothTenants`.
   */
  private assertElevatedTenantlessContext(): void {
    if (this.tenantId) {
      throw new ForbiddenException(
        'Promotion runs across a tenant boundary and requires an elevated tenant-less context; clear the working tenant and retry.',
      );
    }
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Promotion requires an elevated tenant-less context');
    }
  }

  /**
   * THE authorization control. The actor must hold `manage` on
   * `WorkflowDefinition` in BOTH tenants; either side missing is a 403 naming
   * which side failed.
   *
   * This is a PRIVILEGE 403, not the 404-over-403 cross-tenant posture — the
   * distinction `05-nestjs-api.md` §"Imperative Privilege Checks" draws. A
   * cross-tenant slug still returns 404 (see `resolveSourceVersion`), and this
   * check runs first precisely so that 404 is only ever observable by someone
   * already entitled to observe it.
   */
  private async assertManagesBothTenants(userId: string, fromTenantId: string, toTenantId: string): Promise<void> {
    for (const [side, tenantId] of [
      ['source', fromTenantId],
      ['target', toTenantId],
    ] as const) {
      const ability = await this.policyEngine.buildAbility({ userId, tenantId });
      if (!ability.can('manage', PROMOTION_SUBJECT)) {
        throw new ForbiddenException(
          `Promotion requires manage rights on BOTH tenants; you do not hold manage:${PROMOTION_SUBJECT} on the ${side} tenant.`,
        );
      }
    }
  }

  /**
   * The exact immutable version to promote — an explicit `versionNumber`, else
   * the source tenant's ACTIVE PUBLISHED row for that slug.
   *
   * Defaulting to the ACTIVE PUBLISHED row rather than the newest one is
   * deliberate: the newest row may be an unfinished draft, and promoting an
   * unvalidated graph into another tenant is how a cross-tenant push becomes a
   * support ticket. An explicit number promotes exactly what was asked for.
   */
  private async resolveSourceVersion(fromTenantId: string, slug: string, versionNumber?: number): Promise<WorkflowDefinitionEntity> {
    if (versionNumber !== undefined) {
      const versions = await this.definitionRepository.findAllVersionsBySlug(fromTenantId, slug);
      const match = versions.find((row) => row.versionNumber === versionNumber);
      if (!match) {
        throw new NotFoundException(`Workflow '${slug}' has no version ${versionNumber} in the source tenant`);
      }
      return match;
    }

    const published = await this.definitionRepository.findPublishedBySlug(fromTenantId, slug);
    if (!published) {
      throw new BadRequestException(
        `Workflow '${slug}' has no ACTIVE PUBLISHED version in the source tenant. ` +
          'Publish it there, or name an explicit version to promote a draft deliberately.',
      );
    }
    return published;
  }

  /**
   * BLOCK when a node binds a TENANT-OWNED `DocumentTemplate`.
   *
   * A `DocumentTemplate` is a document SHAPE with its own version lineage, and
   * a node's `documentVersionNumber` pins one of its versions. Copying the
   * reference would leave the promoted node pointing at a row the target cannot
   * read; copying the shape is a second deep-copy pipeline this ticket does not
   * take on. Refusing, with the offending nodes NAMED, is the honest answer —
   * and it is what stops a promotion silently restructuring the clinical
   * document the target produces. A SYSTEM-owned shape is genuinely readable
   * cross-tenant and passes.
   */
  private async assertNoTenantOwnedDocumentTemplates(graph: WorkflowGraph): Promise<void> {
    const offenders: string[] = [];
    for (const node of graph.nodes) {
      const documentTemplateId = readStringConfig(node, DOCUMENT_TEMPLATE_ID_KEY);
      if (!documentTemplateId) continue;
      const template = await this.safeFindDocumentTemplate(documentTemplateId);
      // A binding that resolves to nothing is the source tenant's own problem
      // and blocks for the same reason a tenant-owned one does: the promoted
      // node would point at a row the target cannot read.
      if (template && template.tenantId === SYSTEM_TENANT_ID) continue;
      offenders.push(`${node.id} (${node.type})`);
    }
    if (offenders.length > 0) {
      throw new BadRequestException(
        `Promotion blocked: node(s) ${offenders.join(', ')} bind a document template that is not SYSTEM-owned, so it cannot be resolved in the target tenant. ` +
          'Re-bind them to a SYSTEM document template, or remove the binding, before promoting.',
      );
    }
  }

  private async safeFindDocumentTemplate(id: string) {
    try {
      return await this.documentTemplateRepository.findById(id);
    } catch {
      return null;
    }
  }

  /**
   * Alert, never block. Only meaningful when the target already has a version
   * of this workflow: without a previous one there is nothing for a running
   * consultation to "complete on".
   */
  private async buildWarnings(toTenantId: string, targetAlreadyHasVersions: boolean): Promise<string[]> {
    if (!targetAlreadyHasVersions) return [];
    const running = await this.consultationRepository.count({
      filters: { tenantId: toTenantId, status: ConsultationStatus.RECORDING },
    } as never);
    return running > 0 ? [liveConsultationsWarning(running)] : [];
  }

  // =========================================================================
  // The copy
  // =========================================================================

  /**
   * The promoted graph: every node's tenant-owned `promptTemplateId` replaced
   * by a fresh deep copy in the target, its version pin dropped, and its eval
   * gate stripped. Pure with respect to the input — the source entity's own
   * graph is never mutated.
   */
  private async materializeGraph(
    graph: WorkflowGraph,
    source: WorkflowDefinitionEntity,
    toTenantId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<WorkflowGraph> {
    // Sequential, not `Promise.all`: an interactive Prisma transaction client is
    // a SINGLE connection, so concurrent writes through one `tx` are not safe to
    // issue in parallel. Memoized so a template two nodes share is copied once
    // and both nodes end up pointing at the SAME target row — copying it twice
    // would silently fork one prompt into two the target must maintain apart.
    const copied = new Map<string, string>();
    const nodes: WorkflowGraphNode[] = [];

    for (const node of graph.nodes) {
      const config = { ...nodeConfig(node) };
      const templateId = readStringConfig(node, PROMPT_TEMPLATE_ID_KEY);

      if (templateId) {
        let materialized = copied.get(templateId);
        if (materialized === undefined) {
          materialized = (await this.materializeTemplate(templateId, source, toTenantId, userId, tx)) ?? templateId;
          copied.set(templateId, materialized);
        }
        config[PROMPT_TEMPLATE_ID_KEY] = materialized;
        if (materialized !== templateId) {
          // The target's own fresh template starts at v1, so a source pin
          // numbers a version that does not exist here. Dropping it means the
          // node follows the copied template's approved version — which IS v1.
          delete config[PROMPT_VERSION_NUMBER_KEY];
        }
      }

      // The gate's `goldenSetId` names a corpus of Vault-Transit-encrypted
      // `GoldenCase` PHI in the SOURCE tenant. Not even the pointer crosses the
      // boundary; the target binds its own gate deliberately, which is what
      // OD-11 made an explicit tenant-admin act.
      delete config[EVAL_GATE_KEY];

      nodes.push({ ...node, config });
    }

    return { ...graph, nodes };
  }

  /**
   * Deep-copy one bound prompt template into the target tenant.
   *
   * A tenant-owned template id is unreadable in the target and would silently
   * fall through the resolver; dropping the binding instead would land a
   * promoted workflow with part of its configuration missing. A SYSTEM-owned
   * binding keeps its id, because `PromptTemplate` is in
   * `SYSTEM_SHARED_READ_MODELS` and the reference is genuinely valid
   * cross-tenant.
   *
   * Returns null when the source template no longer exists, so the caller keeps
   * the original id rather than writing a null binding onto a generation node.
   */
  private async materializeTemplate(
    templateId: string,
    source: WorkflowDefinitionEntity,
    toTenantId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<string | null> {
    const template = await this.promptTemplateRepository.findById(templateId);
    if (!template) return null;
    // A SYSTEM template is readable from every tenant — copying it would fork
    // the platform catalogue for no benefit.
    if (template.tenantId === SYSTEM_TENANT_ID) return templateId;

    const snapshot = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: toTenantId,
      // Named after the WORKFLOW, not the shared source template:
      // `PromptTemplate` is unique on `(tenantId, name)`, and one template can
      // back several nodes — the id suffix is what keeps two distinct source
      // templates promoted from the same workflow from colliding.
      name: `${source.name} (promoted ${templateId.slice(0, 8)})`,
      description: template.description ?? undefined,
      content: template.content ?? undefined,
      category: template.category ?? undefined,
      // APPROVED, not DRAFT: promotion moves a configuration that was already
      // governed in the source. A DRAFT copy would fall through the resolver and
      // silently change behaviour, which is precisely what promoting an
      // immutable version is supposed to prevent.
      status: 'APPROVED',
      approvedVersionNumber: 1,
      variables: (template.variables as Record<string, unknown> | null) ?? undefined,
      currentVersionNumber: 1,
      tags: template.tags ?? [],
      createdBy: userId,
    });
    const saved = await this.promptTemplateRepository.create(snapshot, tx);

    const v1 = PromptVersionFactory.CreatePromptVersion({
      tenantId: toTenantId,
      promptTemplateId: saved.id,
      versionNumber: 1,
      content: saved.content ?? undefined,
      variables: (saved.variables as Record<string, unknown> | null) ?? undefined,
      changeReason: `Promoted from tenant ${source.tenantId} (workflow '${source.slug}')`,
      changedBy: userId,
      createdBy: userId,
    });
    await this.promptVersionRepository.create(v1, tx);

    return saved.id;
  }

  /**
   * The target tenant's own row for the promoted version — always a DRAFT, and
   * never `isActive` (see the class header).
   *
   * `versionNumber` continues the TARGET's lineage for that slug rather than
   * copying the source's, because `(tenantId, slug, versionNumber)` is unique
   * per tenant and the two lineages are independent. `parentVersionId` is left
   * null: the provenance edge is the `AgentPromotion` row, and a cross-tenant
   * parent pointer would put a navigable path from one tenant's row into
   * another's.
   */
  private async writeTargetDefinition(
    source: WorkflowDefinitionEntity,
    graph: WorkflowGraph,
    checksum: string,
    existingVersions: WorkflowDefinitionEntity[],
    toTenantId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<WorkflowDefinitionEntity> {
    const nextVersionNumber = existingVersions.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;

    const definition = WorkflowDefinitionFactory.CreateDefinition({
      tenantId: toTenantId,
      slug: source.slug,
      name: source.name,
      description: source.description ?? null,
      paletteKey: source.paletteKey,
      versionNumber: nextVersionNumber,
      parentVersionId: null,
      status: WorkflowDefinitionStatus.DRAFT,
      graph: graph as never,
      graphChecksum: checksum,
      // Every server-owned publish artifact stays unset: the target's own
      // validate/compile/publish path produces them, and a compiledConfig
      // carrying the SOURCE tenant's template ids would be worse than none.
      isActive: false,
      needsReview: false,
      tags: source.tags ?? [],
      createdBy: userId,
    } as never);

    return this.definitionRepository.create(definition, tx);
  }

  /**
   * The eval RE-RUNS at the target, against the TARGET's own corpus.
   *
   * The source's golden set is never used and never copied: `GoldenCase` rows
   * hold Vault-Transit-encrypted PHI, and no code path moves one across a
   * tenant boundary — which is why `materializeGraph` strips `evalGate`
   * outright. The golden set is therefore one the caller named, and it must
   * belong to the target tenant (`EvalRunService` enforces that itself — a
   * foreign id raises `DataNotFoundException`).
   *
   * This runs AFTER the copy rather than as a pre-write gate because the
   * promoted configuration and the target's corpus only coexist in the target
   * once the copy has happened; blocking afterwards would mean retracting an
   * immutable audit record. A failure here degrades to a warning — a promotion
   * is never lost to an eval problem.
   */
  private async runTargetEval(
    dto: PromoteWorkflowRequest,
    targetDefinition: WorkflowDefinitionEntity,
    toTenantId: string,
    warnings: string[],
  ): Promise<string | null> {
    const goldenSetId = dto.targetGoldenSetId ?? null;
    if (!goldenSetId) {
      warnings.push('No eval was run: no target golden set was named. Promotion was recorded without an eval attestation.');
      return null;
    }
    if (!this.evalRunService) return null;

    const promptTemplateId = firstPromptTemplateId(readGraph(targetDefinition.graph));

    try {
      const outcome = await this.evalRunService.runGoldenSet({
        goldenSetId,
        tenantId: toTenantId,
        triggerType: 'PROMOTION',
        ...(promptTemplateId ? { promptTemplateId } : {}),
      });
      if (!outcome.passed) {
        warnings.push(`The eval re-run at the target did not pass: ${outcome.failures.join('; ') || 'see the eval run for detail'}.`);
      }
      return outcome.run.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ message: 'Promotion eval re-run failed', toTenantId, goldenSetId, error: message });
      warnings.push(`The eval re-run at the target could not be completed: ${message}`);
      return null;
    }
  }

  // =========================================================================
  // Drift
  // =========================================================================

  /**
   * "Has the target workflow been edited since it was promoted?" — recomputed
   * from the target row's CURRENT graph and compared against the checksum
   * stored on the record. Both sides go through the SAME canonicalisation
   * (`canonicalJson` from `@arcaai/workflow-contract`, which is also what
   * `WorkflowDefinitionService` stamps into `graphChecksum`), so the comparison
   * cannot be wrong by construction.
   */
  private async toResponseWithDrift(promotion: AgentPromotionEntity): Promise<AgentPromotionResponse> {
    const target = promotion.targetAgentVersionId ? await this.safeFindDefinition(promotion.targetAgentVersionId) : null;
    if (!target || target.tenantId !== promotion.toTenantId) {
      return AgentPromotionDtoMapper.toResponse(promotion);
    }
    const graph = readGraph(target.graph);
    if (!graph) return AgentPromotionDtoMapper.toResponse(promotion);
    return AgentPromotionDtoMapper.toResponse(promotion, graphChecksum(graph) !== promotion.checksum);
  }

  private async safeFindDefinition(id: string): Promise<WorkflowDefinitionEntity | null> {
    try {
      return await this.definitionRepository.findById(id);
    } catch {
      return null;
    }
  }
}

// ===========================================================================
// Graph helpers — module-local, deliberately
// ===========================================================================

/** sha256 over the canonical JSON of a graph — the same digest `WorkflowDefinitionService` stamps. */
function graphChecksum(graph: WorkflowGraph): string {
  return createHash('sha256').update(canonicalJson(graph)).digest('hex');
}

/** A graph document read off a `Json` column, or null when it is not one. */
function readGraph(value: unknown): WorkflowGraph | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { nodes?: unknown };
  return Array.isArray(candidate.nodes) ? (value as unknown as WorkflowGraph) : null;
}

function nodeConfig(node: WorkflowGraphNode): Record<string, unknown> {
  const config = node.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

function readStringConfig(node: WorkflowGraphNode, key: string): string | null {
  const value = nodeConfig(node)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The first prompt binding in authored order — what an eval run is judged against. */
function firstPromptTemplateId(graph: WorkflowGraph | null): string | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    const id = readStringConfig(node, PROMPT_TEMPLATE_ID_KEY);
    if (id) return id;
  }
  return null;
}
