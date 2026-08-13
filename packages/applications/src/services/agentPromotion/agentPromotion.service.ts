import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  AgentPromotionEntity,
  AgentPromotionFactory,
  AgentPromotionRepository,
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaScope,
  ConsultationContextSchemaStatus,
  ConsultationContextSchemaVersionRepository,
  ConsultationRepository,
  ConsultationStatus,
  CoreUnitOfWorkService,
  CorePrisma,
  DepartmentAgentEntity,
  DepartmentAgentFactory,
  DepartmentAgentRepository,
  DepartmentAgentRole,
  DepartmentAgentVersionEntity,
  DepartmentAgentVersionFactory,
  DepartmentAgentVersionRepository,
  DepartmentRepository,
  PromptTemplateFactory,
  PromptTemplateRepository,
  PromptVersionFactory,
  PromptVersionRepository,
  ResourceType,
  SysEventType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { IAgentPromotionService } from './IAgentPromotionService';
import { AgentPromotionResponse, PaginatedAgentPromotionResponse, PromoteAgentRequest } from './dto';
import { AgentPromotionDtoMapper } from './agentPromotion.dto.mapper';
import {
  AgentLoopConfig,
  buildLoopConfigSnapshot,
  canonicalAgentConfigJson,
  subscribedKindsProblems,
  writeScopeProblems,
} from '../departmentAgent/constants';
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

/**
 * Promote an agent configuration version from one tenant to another.
 *
 * ## Authorization is the entire control 
 *
 * There is no platform environment, tier or tenant-family concept, so "the
 * actor holds `manage` on `DepartmentAgent` in BOTH tenants" is all that
 * constrains which tenants may be promoted between. It is enforced in
 * `assertManagesBothTenants` and it runs BEFORE any read, so a caller who has
 * not proven it cannot use a 403/404 difference as an existence oracle over
 * either tenant's data.
 *
 * ## Tenant context
 *
 * `promote` runs under an ELEVATED TENANT-LESS context, exactly as
 * `AgentTemplateResyncService` does. That is a MECHANICAL requirement, not a
 * second authorization control: with a pinned tenant the tenant-scope Prisma
 * extension forces the caller's `tenantId` into every read, which makes a
 * cross-tenant read impossible rather than merely unauthorized. The corollary
 * matters when reading this file — in pass-through mode the extension injects
 * NOTHING, so **every repository call below passes `tenantId` explicitly**. A
 * missing filter here reads across all tenants.
 *
 * `DepartmentAgent` is deliberately NOT added to `SYSTEM_SHARED_READ_MODELS`;
 * that would make every tenant's agents mutually readable platform-wide.
 *
 * ## What is copied
 *
 * Promotion copies VALUES, never REFERENCES. A reference — a template id, a
 * golden-set id, a department id — is meaningful only inside the tenant that
 * owns it. The promoted artifact is the exact immutable
 * `DepartmentAgentVersion.configSnapshot`, read from the version table and
 * never re-derived from the live source agent, so a mid-promotion edit at the
 * source cannot leak into the target. Bound prompt templates are DEEP-COPIED
 * into the target (except SYSTEM-owned ones, which are genuinely readable
 * cross-tenant). `goldenSetId` is NOT copied — not even the pointer to a
 * corpus of Vault-Transit-encrypted `GoldenCase` PHI crosses a tenant
 * boundary. See for the full table.
 *
 * ## Atomicity (closing )
 *
 * Everything promotion writes into the TARGET tenant — the deep-copied prompt
 * templates, the agent (created or advanced), its immutable version row, and
 * the `AgentPromotion` audit record — commits inside ONE `runInTransaction`.
 * The eval re-run and the `evalRunId` write that follows it stay OUTSIDE: the
 * eval is an external, long-running call, and holding a Postgres transaction
 * open across it would be a worse defect than the partial-promotion window
 * being closed (D-7 already makes the eval non-blocking and post-copy).
 */
@Injectable()
export class AgentPromotionService extends BaseService implements IAgentPromotionService {
  private readonly logger = new Logger(AgentPromotionService.name);

  constructor(
    private readonly promotionRepository: AgentPromotionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly agentRepository: DepartmentAgentRepository,
    private readonly agentVersionRepository: DepartmentAgentVersionRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    // Required, NOT optional. 's create/update path degrades to a
    // structural-only check when these are unwired; a cross-tenant privileged
    // write must not, so the compatibility gate here is unconditional.
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly contextSchemaVersionRepository: ConsultationContextSchemaVersionRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly policyEngine: PolicyEngine,
    // The DOMAINS `CoreUnitOfWorkService`, not the identically
    // named unwired class under `services/baseServices`. REQUIRED, not
    // optional: promotion is a privileged cross-tenant write, and degrading
    // silently to a non-transactional sequence when the dependency is unwired
    // would reintroduce exactly the partial-promotion window this closes —
    // the same reasoning D-6 applies to the context-schema repositories above.
    private readonly unitOfWork: CoreUnitOfWorkService,
    @Optional() @Inject(EvalRunService) private readonly evalRunService?: EvalRunService,
  ) {
    super(eventEmitter, clsService, ResourceType.AgentPromotion);
  }

  // =========================================================================
  // Reads — ORDINARY tenant-scoped, by the target tenant that owns the record
  // =========================================================================

  async list(query: PaginatedQuery, targetAgentId?: string): Promise<PaginatedAgentPromotionResponse> {
    const tenantId = this.requireTenant();

    const where: Record<string, unknown> = { tenantId };
    if (targetAgentId) where.targetAgentId = targetAgentId;

    const rows = await this.promotionRepository.findAll({
      ...withFormattedPaginatedProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters is a structural record; this is a plain tenant/agent filter the repository accepts as-is (the DepartmentAgentService.list precedent).
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
      throw new NotFoundException(`Agent promotion ${id} not found`);
    }
    return this.toResponseWithDrift(promotion);
  }

  // =========================================================================
  // Promote — ELEVATED TENANT-LESS context
  // =========================================================================

  async promote(dto: PromoteAgentRequest): Promise<AgentPromotionResponse> {
    const { fromTenantId, toTenantId } = dto;

    // ---- 1. Mechanical precondition (see the class header) ----------------
    this.assertElevatedTenantlessContext();

    const userId = this.requestUserId;
    if (!userId) {
      throw new ForbiddenException('Promotion requires an authenticated user');
    }

    if (fromTenantId === toTenantId) {
      throw new BadRequestException('A promotion must target a DIFFERENT tenant; use clone to copy within one tenant');
    }

    // ---- 2. THE authorization control, BEFORE any read (D10) --------------
    await this.assertManagesBothTenants(userId, fromTenantId, toTenantId);

    // ---- 3. Source agent + the immutable version being promoted -----------
    const source = await this.agentRepository.findById(dto.sourceAgentId);
    if (!source || source.tenantId !== fromTenantId) {
      throw new NotFoundException(`Department agent ${dto.sourceAgentId} not found`);
    }

    const sourceVersion = await this.resolveSourceVersion(source, dto.agentVersionNumber);
    const snapshot = sourceVersion.configSnapshot as Record<string, unknown>;
    const loopConfig = snapshotToLoopConfig(snapshot);

    // ---- 4. Target department — reuse-only, matched by CODE ---------------
    const targetDepartment = await this.resolveTargetDepartment(source, toTenantId);

    // ---- 5. Blocking gates ------------------------------------------------
    await this.assertContextKindsDeclaredInTarget(loopConfig, toTenantId, targetDepartment.id);

    const existing = await this.agentRepository.findBySlug(toTenantId, targetDepartment.id, source.slug);
    await this.assertPrimaryRoleAvailable(loopConfig, toTenantId, targetDepartment.id, existing?.id);

    // ---- 6. Non-blocking alert -------------------------------------
    const warnings = await this.buildWarnings(toTenantId, existing);

    const checksum = createHash('sha256').update(canonicalAgentConfigJson(snapshot)).digest('hex');

    // ---- 7 + 8. The copy and its immutable record — ONE transaction -------
    // , closing. Everything the promotion produces in the
    // TARGET tenant — the deep-copied prompt templates, the agent (created or
    // advanced), its version row, and the AgentPromotion audit record — commits
    // or rolls back together. Before this, the sequence was ordered so the
    // audit row landed LAST, which guaranteed a record never claimed something
    // that did not complete; but the reverse window stayed open, leaving a
    // PARTIALLY-PROMOTED agent with no record saying so. `Repository.update`
    // now takes a `tx`, so the create-OR-update path (D-10) is wrappable.
    //
    // Every write below therefore threads `tx`. A repository caches its
    // database context at construction, so the CLS propagation inside
    // `runInTransaction` would NOT reach these singletons on its own — passing
    // `tx` explicitly is what actually enrols the write.
    const { targetAgent, savedPromotion } = await this.unitOfWork.runInTransaction(async (tx: CorePrisma.TransactionClient) => {
      const agent = existing
        ? await this.advanceTargetAgent(existing, source, loopConfig, toTenantId, targetDepartment.id, userId, tx)
        : await this.createTargetAgent(source, loopConfig, toTenantId, targetDepartment.id, userId, tx);

      const targetVersion = await this.writeTargetVersion(agent, snapshot, checksum, fromTenantId, sourceVersion, userId, tx);

      const promotion = AgentPromotionFactory.CreateAgentPromotion({
        fromTenantId,
        toTenantId,
        agentVersionId: sourceVersion.id,
        sourceAgentId: source.id,
        targetAgentId: agent.id,
        targetAgentVersionId: targetVersion?.id ?? null,
        configSnapshot: snapshot as never,
        checksum,
        sourceEvalRunId: dto.sourceEvalRunId ?? null,
        warnings: warnings as never,
        promotedBy: userId,
        createdBy: userId,
        metaData: dto.changeReason ? { changeReason: dto.changeReason } : undefined,
      } as never);
      promotion.validate();

      return { targetAgent: agent, savedPromotion: await this.promotionRepository.create(promotion, tx) };
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
        // in the payload — the `AgentTemplateResyncService` precedent.
        fromTenantId,
        toTenantId,
        sourceAgentId: source.id,
        targetAgentId: targetAgent.id,
        agentVersionId: sourceVersion.id,
        checksum,
      },
    });

    // ---- 9. Eval RE-RUNS at the target, against the TARGET's corpus -------
    const evalRunId = await this.runTargetEval(dto, targetAgent, toTenantId, warnings);
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
   * `DepartmentAgent` in BOTH tenants; either side missing is a 403 naming
   * which side failed.
   *
   * This is a PRIVILEGE 403, not the 404-over-403 cross-tenant posture — the
   * distinction `05-nestjs-api.md` §"Imperative Privilege Checks" draws. A
   * cross-tenant agent id still returns 404 (see `promote` step 3), and this
   * check runs first precisely so that 404 is only ever observable by someone
   * already entitled to observe it.
   */
  private async assertManagesBothTenants(userId: string, fromTenantId: string, toTenantId: string): Promise<void> {
    for (const [side, tenantId] of [
      ['source', fromTenantId],
      ['target', toTenantId],
    ] as const) {
      const ability = await this.policyEngine.buildAbility({ userId, tenantId });
      if (!ability.can('manage', 'DepartmentAgent')) {
        throw new ForbiddenException(
          `Promotion requires manage rights on BOTH tenants; you do not hold manage:DepartmentAgent on the ${side} tenant.`,
        );
      }
    }
  }

  /** The exact immutable version to promote — explicit number, else the latest. */
  private async resolveSourceVersion(source: DepartmentAgentEntity, versionNumber?: number): Promise<DepartmentAgentVersionEntity> {
    const version =
      versionNumber !== undefined
        ? await this.agentVersionRepository.findByAgentAndVersionNumber(source.id, versionNumber)
        : await this.agentVersionRepository.findLatestForAgent(source.id);

    if (!version) {
      throw new BadRequestException(
        versionNumber !== undefined
          ? `Agent '${source.slug}' has no configuration version ${versionNumber} to promote`
          : `Agent '${source.slug}' has no immutable configuration version to promote; configure its loop surface first`,
      );
    }
    // Defensive: the version table is tenant-scoped, but this path runs with
    // the extension in pass-through, so nothing else enforces it here.
    if (version.tenantId !== source.tenantId) {
      throw new NotFoundException(`Department agent ${source.id} not found`);
    }
    return version;
  }

  /**
   * REUSE-ONLY, matched by department CODE — the `AgentTemplateResyncService`
   * rule: promotion reconciles an agent onto a department the
   * target tenant already runs; it must never provision one.
   */
  private async resolveTargetDepartment(source: DepartmentAgentEntity, toTenantId: string) {
    const sourceDepartment = await this.departmentRepository.findById(source.departmentId);
    if (!sourceDepartment) {
      throw new BadRequestException(`Source agent ${source.id} binds a missing department`);
    }
    const targetDepartment = await this.departmentRepository.findByCode(toTenantId, sourceDepartment.code);
    if (!targetDepartment) {
      throw new BadRequestException(
        `Promotion blocked: the target tenant has no department with code '${sourceDepartment.code}'. ` +
          'Promotion reuses an existing department and never provisions one.',
      );
    }
    return targetDepartment;
  }

  /**
   * blocked when the target lacks a context kind the promoted agent
   * subscribes to (or an output kind it writes), with the missing keys NAMED.
   *
   * Unlike 's create/update path this never degrades to a
   * structural-only check: an unresolvable kind reference must not be written
   * into another tenant on a privileged path.
   */
  private async assertContextKindsDeclaredInTarget(config: AgentLoopConfig, toTenantId: string, targetDepartmentId: string): Promise<void> {
    const kindKeys = config.subscribedKinds ? subscribedKindsProblems(config.subscribedKinds).kindKeys : [];
    const outputKeys = config.writeScope ? writeScopeProblems(config.writeScope).outputKeys : [];
    if (kindKeys.length === 0 && outputKeys.length === 0) return;

    const declared = await this.resolveServableContextDefinition(toTenantId, targetDepartmentId);
    if (!declared) {
      throw new BadRequestException(
        `Promotion blocked: the promoted agent references context ${describeKeys(kindKeys, outputKeys)}, ` +
          'but the target department has no published context schema to resolve them against.',
      );
    }

    const missingKinds = kindKeys.filter((key) => !declared.kinds.has(key));
    const missingOutputs = outputKeys.filter((key) => !declared.outputs.has(key));
    if (missingKinds.length > 0 || missingOutputs.length > 0) {
      const parts: string[] = [];
      if (missingKinds.length > 0) parts.push(`kind(s) ${missingKinds.join(', ')}`);
      if (missingOutputs.length > 0) parts.push(`output(s) ${missingOutputs.join(', ')}`);
      throw new BadRequestException(
        `Promotion blocked: the target department does not declare ${parts.join(' and ')}. ` +
          'Publish them on the target’s context schema before promoting.',
      );
    }
  }

  /**
   * The target department's servable context vocabulary — the same
   * DEPARTMENT → TENANT cascade `ConsultationContextSchemaService` uses, read
   * with an EXPLICIT `toTenantId` because the extension injects nothing here.
   */
  private async resolveServableContextDefinition(
    tenantId: string,
    departmentId: string,
  ): Promise<{ kinds: Set<string>; outputs: Set<string> } | null> {
    const candidates = [
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.DEPARTMENT, departmentId),
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.TENANT, null),
    ];

    for (const schema of candidates) {
      if (!schema) continue;
      const servable =
        schema.pinnedVersionNumber != null &&
        (schema.status === ConsultationContextSchemaStatus.PUBLISHED || schema.status === ConsultationContextSchemaStatus.APPROVED);
      if (!servable) continue;
      const version = await this.contextSchemaVersionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber as number);
      if (version) return extractDeclaredContextKeys(version.definition);
    }
    return null;
  }

  /** At most one ENABLED PRIMARY per department — in the TARGET department. */
  private async assertPrimaryRoleAvailable(
    config: AgentLoopConfig,
    toTenantId: string,
    targetDepartmentId: string,
    excludeId?: string,
  ): Promise<void> {
    if (config.role !== DepartmentAgentRole.PRIMARY) return;
    const existingPrimary = await this.agentRepository.findPrimaryForDepartment(toTenantId, targetDepartmentId, excludeId);
    if (existingPrimary) {
      throw new BadRequestException(
        `Promotion blocked: the promoted agent is PRIMARY, but the target department already has a PRIMARY agent ` +
          `('${existingPrimary.slug}'). Change its role before promoting.`,
      );
    }
  }

  /**
   * alert, never block. Only meaningful when the target agent already
   * exists: without a previous version there is nothing for a running
   * consultation to "complete on".
   */
  private async buildWarnings(toTenantId: string, existing: DepartmentAgentEntity | null): Promise<string[]> {
    if (!existing) return [];
    const running = await this.consultationRepository.count({
      filters: { tenantId: toTenantId, status: ConsultationStatus.RECORDING },
    } as never);
    return running > 0 ? [liveConsultationsWarning(running)] : [];
  }

  // =========================================================================
  // The copy
  // =========================================================================

  private async createTargetAgent(
    source: DepartmentAgentEntity,
    config: AgentLoopConfig,
    toTenantId: string,
    targetDepartmentId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<DepartmentAgentEntity> {
    const bindings = await this.materializeBindings(source, toTenantId, targetDepartmentId, userId, tx);

    const agent = DepartmentAgentFactory.CreateDepartmentAgent({
      tenantId: toTenantId,
      departmentId: targetDepartmentId,
      name: source.name,
      slug: source.slug,
      description: source.description ?? null,
      promptTemplateId: bindings.promptTemplateId,
      newPatientTemplateId: bindings.newPatientTemplateId,
      revisitTemplateId: bindings.revisitTemplateId,
      preSummaryTemplateId: bindings.preSummaryTemplateId,
      livePromptTemplateId: bindings.livePromptTemplateId,
      // The target's own fresh template starts at v1; a source pin numbers a
      // version of a template that does not exist here.
      pinnedVersionNumber: null,
      dnaStylePolicy: source.dnaStylePolicy,
      harnessOverrides: source.harnessOverrides ?? null,
      toolConfig: source.toolConfig ?? null,
      llmOverrides: source.llmOverrides ?? null,
      // goldenSetId is DELIBERATELY absent — see the class header.
      // isDefault is DELIBERATELY absent — a promotion never silently
      // re-points the target department's default agent.
      // templateLocked stays false: the copy is the target tenant's to edit.
      ...loopConfigProps(config),
      tags: source.tags ?? [],
      createdBy: userId,
    } as never);

    return this.agentRepository.create(agent, tx);
  }

  private async advanceTargetAgent(
    existing: DepartmentAgentEntity,
    source: DepartmentAgentEntity,
    config: AgentLoopConfig,
    toTenantId: string,
    targetDepartmentId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<DepartmentAgentEntity> {
    const bindings = await this.materializeBindings(source, toTenantId, targetDepartmentId, userId, tx);

    existing.promptTemplateId = bindings.promptTemplateId;
    existing.newPatientTemplateId = bindings.newPatientTemplateId;
    existing.revisitTemplateId = bindings.revisitTemplateId;
    existing.preSummaryTemplateId = bindings.preSummaryTemplateId;
    existing.livePromptTemplateId = bindings.livePromptTemplateId;
    existing.pinnedVersionNumber = null;
    existing.dnaStylePolicy = source.dnaStylePolicy;
    existing.harnessOverrides = source.harnessOverrides ?? null;
    existing.toolConfig = source.toolConfig ?? null;
    existing.llmOverrides = source.llmOverrides ?? null;
    existing.role = config.role as DepartmentAgentRole;
    existing.subscribedKinds = config.subscribedKinds ?? null;
    existing.writeScope = config.writeScope ?? null;
    existing.goal = config.goal ?? null;
    existing.guardrailProfile = config.guardrailProfile ?? null;
    existing.alwaysActions = config.alwaysActions ?? null;
    existing.neverActions = config.neverActions ?? null;
    existing.updatedBy = userId;

    // The third argument is the whole point of this ticket: before
    // it, this line could not join the transaction and the create-OR-update
    // path could not be wrapped at all.
    return this.agentRepository.update(existing.id, existing, tx);
  }

  /**
   * Deep-copy every bound prompt template into the target tenant.
   *
   * A tenant-owned template id is unreadable in the target and would silently
   * fall through the resolver; dropping the bindings instead would land a
   * promoted agent with part of its configuration missing — the exact failure
   * this ticket exists to fix. A SYSTEM-owned binding keeps its id, because
   * `PromptTemplate` is in `SYSTEM_SHARED_READ_MODELS` and the reference is
   * genuinely valid cross-tenant.
   */
  private async materializeBindings(
    source: DepartmentAgentEntity,
    toTenantId: string,
    targetDepartmentId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ) {
    // Sequential, not `Promise.all`: an interactive Prisma transaction client
    // is a SINGLE connection, so concurrent writes through one `tx` are not
    // safe to issue in parallel.
    const promptTemplateId = await this.materializeTemplate(source.promptTemplateId, source, toTenantId, targetDepartmentId, userId, tx);
    const newPatientTemplateId = await this.materializeTemplate(source.newPatientTemplateId, source, toTenantId, targetDepartmentId, userId, tx);
    const revisitTemplateId = await this.materializeTemplate(source.revisitTemplateId, source, toTenantId, targetDepartmentId, userId, tx);
    const preSummaryTemplateId = await this.materializeTemplate(source.preSummaryTemplateId, source, toTenantId, targetDepartmentId, userId, tx);
    const livePromptTemplateId = await this.materializeTemplate(source.livePromptTemplateId, source, toTenantId, targetDepartmentId, userId, tx);

    if (!promptTemplateId) {
      throw new BadRequestException(`Source agent ${source.id} binds a prompt template that no longer exists`);
    }
    return { promptTemplateId, newPatientTemplateId, revisitTemplateId, preSummaryTemplateId, livePromptTemplateId };
  }

  private async materializeTemplate(
    templateId: string | null | undefined,
    source: DepartmentAgentEntity,
    toTenantId: string,
    targetDepartmentId: string,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<string | null> {
    if (!templateId) return null;

    const template = await this.promptTemplateRepository.findById(templateId);
    if (!template) return null;
    // A SYSTEM template is readable from every tenant — copying it would fork
    // the platform catalogue for no benefit.
    if (template.tenantId === SYSTEM_TENANT_ID) return templateId;

    const snapshot = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: toTenantId,
      // Named after the AGENT, not the shared source template: PromptTemplate
      // is unique on (tenantId, name), and one template can back several
      // agents — the `AgentTemplateResyncService.cloneGoldenIntoTenant`
      // reasoning applies verbatim.
      name: `${source.name} (${template.id === source.promptTemplateId ? 'promoted' : 'promoted binding'})`,
      description: template.description ?? undefined,
      content: template.content ?? undefined,
      category: template.category ?? undefined,
      // APPROVED, not DRAFT: promotion moves a configuration that was already
      // governed in the source. A DRAFT copy would fall through the resolver
      // and silently change behaviour, which is precisely what promoting an
      // immutable version is supposed to prevent. (`clone()` differs on
      // purpose — it exists so a tenant can CUSTOMIZE, so its copy starts as a
      // DRAFT awaiting approval.)
      status: 'APPROVED',
      variables: (template.variables as Record<string, unknown> | null) ?? undefined,
      departmentId: targetDepartmentId,
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
      changeReason: `Promoted from tenant ${source.tenantId} (agent '${source.slug}')`,
      changedBy: userId,
      createdBy: userId,
    });
    await this.promptVersionRepository.create(v1, tx);

    return saved.id;
  }

  /** The target's own immutable snapshot of the promoted configuration. */
  private async writeTargetVersion(
    targetAgent: DepartmentAgentEntity,
    snapshot: Record<string, unknown>,
    checksum: string,
    fromTenantId: string,
    sourceVersion: DepartmentAgentVersionEntity,
    userId: string,
    tx: CorePrisma.TransactionClient,
  ): Promise<DepartmentAgentVersionEntity | null> {
    // Read, not write, so it stays on the ordinary client: the target agent's
    // committed version history is what determines the next version number,
    // and nothing written inside this transaction adds to it.
    const latest = await this.agentVersionRepository.findLatestForAgent(targetAgent.id);
    if (latest && latest.checksum === checksum) {
      // Re-promoting an identical configuration is a no-op for the version
      // table (the `writeLoopConfigVersionIfNeeded` guard), but it still
      // records a promotion — "this was promoted again, on this date, by this
      // actor" is exactly what the audit row is for.
      return latest;
    }

    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({
      tenantId: targetAgent.tenantId,
      agentId: targetAgent.id,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      configSnapshot: snapshot as never,
      checksum,
      changeReason: `Promoted from tenant ${fromTenantId} (version ${sourceVersion.versionNumber})`,
      createdBy: userId,
    });
    return this.agentVersionRepository.create(version, tx);
  }

  /**
   * the eval RE-RUNS at the target, against the TARGET's own corpus.
   *
   * The source's `goldenSetId` is never used and never copied: `GoldenCase`
   * rows hold Vault-Transit-encrypted PHI, and no code path moves one across a
   * tenant boundary. The golden set is therefore the target agent's own, or one
   * the caller named that must belong to the target tenant (`EvalRunService`
   * enforces that itself — a foreign id raises `DataNotFoundException`).
   *
   * This runs AFTER the copy rather than as a pre-write gate because the
   * promoted configuration and the target's corpus only coexist in the target
   * once the copy has happened; blocking afterwards would mean retracting an
   * immutable audit record. The gate that genuinely blocks is the context-kind
   * compatibility check. A failure here degrades to a warning — a promotion is
   * never lost to an eval problem.
   */
  private async runTargetEval(
    dto: PromoteAgentRequest,
    targetAgent: DepartmentAgentEntity,
    toTenantId: string,
    warnings: string[],
  ): Promise<string | null> {
    const goldenSetId = dto.targetGoldenSetId ?? targetAgent.goldenSetId ?? null;
    if (!goldenSetId) {
      warnings.push('No eval was run: the target agent has no golden set. Promotion was recorded without an eval attestation.');
      return null;
    }
    if (!this.evalRunService) return null;

    try {
      const outcome = await this.evalRunService.runGoldenSet({
        goldenSetId,
        tenantId: toTenantId,
        triggerType: 'PROMOTION',
        promptTemplateId: targetAgent.promptTemplateId,
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
   * "Has the target agent been edited since it was promoted into?" — recomputed
   * from the agent's CURRENT loop config and compared against the checksum
   * stored on the record. Both sides go through the SAME shared
   * canonicalisation (`constants.ts`), which is why that helper was hoisted out
   * of `departmentAgent.service.ts`: two implementations would make this
   * comparison wrong by construction.
   */
  private async toResponseWithDrift(promotion: AgentPromotionEntity): Promise<AgentPromotionResponse> {
    const targetAgent = await this.agentRepository.findById(promotion.targetAgentId);
    if (!targetAgent || targetAgent.tenantId !== promotion.toTenantId) {
      return AgentPromotionDtoMapper.toResponse(promotion);
    }
    const current = createHash('sha256')
      .update(canonicalAgentConfigJson(buildLoopConfigSnapshot(targetAgent)))
      .digest('hex');
    return AgentPromotionDtoMapper.toResponse(promotion, current !== promotion.checksum);
  }
}

/** The seven fields, read back off an immutable `configSnapshot`. */
function snapshotToLoopConfig(snapshot: Record<string, unknown>): AgentLoopConfig {
  return {
    role: typeof snapshot.role === 'string' ? snapshot.role : DepartmentAgentRole.SPECIALIST,
    subscribedKinds: (snapshot.subscribedKinds as Record<string, unknown> | null) ?? null,
    writeScope: (snapshot.writeScope as Record<string, unknown> | null) ?? null,
    goal: (snapshot.goal as Record<string, unknown> | null) ?? null,
    guardrailProfile: (snapshot.guardrailProfile as string | null) ?? null,
    alwaysActions: (snapshot.alwaysActions as string[] | null) ?? null,
    neverActions: (snapshot.neverActions as string[] | null) ?? null,
  };
}

/** The seven fields as factory props — every one of them, so none is silently dropped. */
function loopConfigProps(config: AgentLoopConfig): Record<string, unknown> {
  return {
    role: config.role,
    subscribedKinds: config.subscribedKinds ?? null,
    writeScope: config.writeScope ?? null,
    goal: config.goal ?? null,
    guardrailProfile: config.guardrailProfile ?? null,
    alwaysActions: config.alwaysActions ?? null,
    neverActions: config.neverActions ?? null,
  };
}

function describeKeys(kindKeys: string[], outputKeys: string[]): string {
  const parts: string[] = [];
  if (kindKeys.length > 0) parts.push(`kind(s) ${kindKeys.join(', ')}`);
  if (outputKeys.length > 0) parts.push(`output(s) ${outputKeys.join(', ')}`);
  return parts.join(' and ');
}

/** Every declared `kinds[].key` / `outputs[].key` in a schema `definition` document. */
function extractDeclaredContextKeys(definition: unknown): { kinds: Set<string>; outputs: Set<string> } {
  const kinds = new Set<string>();
  const outputs = new Set<string>();
  if (definition !== null && typeof definition === 'object' && !Array.isArray(definition)) {
    const def = definition as Record<string, unknown>;
    if (Array.isArray(def.kinds)) {
      for (const kind of def.kinds) {
        const key = (kind as Record<string, unknown> | null)?.key;
        if (typeof key === 'string') kinds.add(key);
      }
    }
    if (Array.isArray(def.outputs)) {
      for (const output of def.outputs) {
        const key = (output as Record<string, unknown> | null)?.key;
        if (typeof key === 'string') outputs.add(key);
      }
    }
  }
  return { kinds, outputs };
}
