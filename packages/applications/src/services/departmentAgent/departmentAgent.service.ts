import { Injectable, BadRequestException, ConflictException, ForbiddenException, Inject, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import {
  DepartmentAgentRepository,
  DepartmentAgentFactory,
  DepartmentAgentEntity,
  DepartmentAgentRole,
  DepartmentAgentVersionRepository,
  DepartmentAgentVersionFactory,
  DepartmentRepository,
  PromptTemplateRepository,
  PromptTemplateEntity,
  PromptTemplateFactory,
  PromptVersionRepository,
  PromptVersionFactory,
  AiModelRepository,
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaVersionRepository,
  ConsultationContextSchemaScope,
  ConsultationContextSchemaStatus,
  ModelTaskType,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IDepartmentAgentService } from './IDepartmentAgentService';
import {
  CreateDepartmentAgentRequest,
  UpdateDepartmentAgentRequest,
  CloneDepartmentAgentRequest,
  DepartmentAgentResponse,
  PaginatedDepartmentAgentResponse,
} from './dto';
import { DepartmentAgentDtoMapper } from './departmentAgent.dto.mapper';
import {
  actionListProblems,
  actionOverlapProblems,
  disallowedHarnessOverrideKeys,
  goalProblems,
  guardrailProfileProblems,
  llmOverridesProblems,
  subscribedKindsProblems,
  toolConfigProblems,
  writeScopeProblems,
} from './constants';
import { EvalPromotionGateService } from '../eval/eval-promotion-gate.service';
import { BaseService, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

/**
 * Single source of the locked-template refusal text (mirrors
 * `PipelineService.TEMPLATE_LOCKED_MESSAGE`). The console surfaces it verbatim,
 * and the unit/e2e suites assert it, so it must not drift.
 */
export const AGENT_TEMPLATE_LOCKED_MESSAGE = 'Template copies are read-only — clone to customize';

@Injectable()
export class DepartmentAgentService extends BaseService implements IDepartmentAgentService {
  constructor(
    private readonly agentRepository: DepartmentAgentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    // Optional (append-only DI); the OD-3 eval promotion gate. When present,
    // re-pointing this agent's pin to a new version runs the eval (if the agent
    // references a golden set) and blocks (409) on a gate failure in block-mode.
    @Optional() @Inject(EvalPromotionGateService) private readonly promotionGate?: EvalPromotionGateService,
    // TASK-635 RF-4: validates `llmOverrides` model slugs against the ENABLED
    // TEXT_GENERATION catalogue. Appended as an OPTIONAL trailing dependency
    // (the established fixture-arity convention) so existing unit fixtures that
    // construct this service positionally keep compiling; when it is absent the
    // structural validation still runs and only the catalogue check is skipped.
    @Optional() @Inject(AiModelRepository) private readonly aiModelRepository?: AiModelRepository,
    // TASK-659, same append-only OPTIONAL convention as above.
    // Writes the immutable loop-config snapshot on create/update; when absent
    // (existing unit fixtures) no version row is written and everything else
    // is unaffected.
    @Optional() @Inject(DepartmentAgentVersionRepository) private readonly agentVersionRepository?: DepartmentAgentVersionRepository,
    // Cross-checks `subscribedKinds`/`writeScope` kind/output keys against the
    // department's resolved ConsultationContextSchemaVersion (TASK-658). When
    // either is absent, the structural shape checks still run and only the
    // "does this kind exist" check is skipped — mirrors `aiModelRepository`.
    @Optional() @Inject(ConsultationContextSchemaRepository) private readonly contextSchemaRepository?: ConsultationContextSchemaRepository,
    @Optional()
    @Inject(ConsultationContextSchemaVersionRepository)
    private readonly contextSchemaVersionRepository?: ConsultationContextSchemaVersionRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.DepartmentAgent);
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async list(query: PaginatedQuery, departmentId?: string): Promise<PaginatedDepartmentAgentResponse> {
    const tenantId = this.requireTenant();

    const where: Record<string, unknown> = { tenantId };
    if (departmentId) where.departmentId = departmentId;

    const rows = await this.agentRepository.findAll({
      ...withFormattedPaginatedProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters is a structural record; the where clause is a plain tenant/department filter that the repository accepts as-is.
      where: where as any,
    });
    const count = await this.agentRepository.count({
      ...withFormattedCountProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same plain tenant/department filter as the paginated read above.
      where: where as any,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count } });

    const { limit, page } = query;
    return new PaginatedDepartmentAgentResponse({
      page: page ?? 0,
      limit: limit ?? 0,
      count,
      data: rows.map(DepartmentAgentDtoMapper.toResponse),
    });
  }

  async getById(id: string): Promise<DepartmentAgentResponse> {
    const agent = await this.loadOwned(id);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: agent.id });
    return DepartmentAgentDtoMapper.toResponse(agent);
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(dto: CreateDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    const tenantId = this.requireTenant();
    const userId = this.requestUserId;

    await this.assertDepartmentInTenant(dto.departmentId, tenantId);

    const isUnique = await this.agentRepository.isSlugUnique(tenantId, dto.departmentId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Department agent with slug '${dto.slug}' already exists in this department`);
    }

    const template = await this.assertTemplateBindable(tenantId, dto.promptTemplateId, dto.departmentId);
    this.validateHarnessOverrides(dto.harnessOverrides);
    await this.assertCapabilityBindingsBindable(tenantId, dto.departmentId, dto);
    this.validateToolConfig(dto.toolConfig);
    await this.validateLlmOverrides(dto.llmOverrides);
    if (dto.pinnedVersionNumber !== undefined && dto.pinnedVersionNumber !== null) {
      await this.assertPinnedVersionApproved(template, dto.pinnedVersionNumber);
    }
    // TASK-659 — loop configuration + promotion surface.
    await this.assertSinglePrimaryPerDepartment(tenantId, dto.departmentId, dto.role);
    await this.validateSubscribedKinds(tenantId, dto.departmentId, dto.subscribedKinds);
    await this.validateWriteScope(tenantId, dto.departmentId, dto.writeScope);
    this.validateGoal(dto.goal);
    this.validateGuardrailProfile(dto.guardrailProfile);
    this.validateActionLists(dto.alwaysActions ?? null, dto.neverActions ?? null);

    const agent = DepartmentAgentFactory.CreateDepartmentAgent({
      tenantId,
      departmentId: dto.departmentId,
      name: dto.name,
      slug: dto.slug,
      description: dto.description ?? null,
      promptTemplateId: dto.promptTemplateId,
      pinnedVersionNumber: dto.pinnedVersionNumber ?? null,
      dnaStylePolicy: dto.dnaStylePolicy,
      harnessOverrides: dto.harnessOverrides ?? null,
      goldenSetId: dto.goldenSetId ?? null,
      newPatientTemplateId: dto.newPatientTemplateId ?? null,
      revisitTemplateId: dto.revisitTemplateId ?? null,
      preSummaryTemplateId: dto.preSummaryTemplateId ?? null,
      livePromptTemplateId: dto.livePromptTemplateId ?? null,
      toolConfig: dto.toolConfig ?? null,
      llmOverrides: dto.llmOverrides ?? null,
      tags: dto.tags ?? [],
      role: dto.role,
      subscribedKinds: dto.subscribedKinds ?? null,
      writeScope: dto.writeScope ?? null,
      goal: dto.goal ?? null,
      guardrailProfile: dto.guardrailProfile ?? null,
      alwaysActions: dto.alwaysActions ?? null,
      neverActions: dto.neverActions ?? null,
      createdBy: userId ?? undefined,
    });

    const saved = await this.agentRepository.create(agent);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, name: saved.name, departmentId: saved.departmentId },
    });

    await this.writeLoopConfigVersionIfNeeded(saved);

    return DepartmentAgentDtoMapper.toResponse(saved);
  }

  /**
   * Update an agent's editable fields. OCC-guarded via `updateWithVersion`
   * (drift → OptimisticConcurrencyException → 412). Locked template copies are
   * read-only for content (403).
   */
  async update(id: string, dto: UpdateDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    const tenantId = this.requireTenant();
    const userId = this.requestUserId;

    const agent = await this.loadOwned(id);
    this.assertNotTemplateLocked(agent);

    if (dto.slug && dto.slug !== agent.slug) {
      const isUnique = await this.agentRepository.isSlugUnique(tenantId, agent.departmentId, dto.slug, id);
      if (!isUnique) {
        throw new BadRequestException(`Department agent with slug '${dto.slug}' already exists in this department`);
      }
    }

    // Re-validate the binding when the bound template changes; a bound template
    // must stay visible to the tenant and department-compatible.
    if (dto.promptTemplateId && dto.promptTemplateId !== agent.promptTemplateId) {
      await this.assertTemplateBindable(tenantId, dto.promptTemplateId, agent.departmentId);
    }
    this.validateHarnessOverrides(dto.harnessOverrides);
    // Every capability binding rides the SAME `update()` path, so a locked
    // template copy already rejected them at `assertNotTemplateLocked` above —
    // "clone to customize" applies to the new columns with zero extra code.
    await this.assertCapabilityBindingsBindable(tenantId, agent.departmentId, dto);
    this.validateToolConfig(dto.toolConfig);
    await this.validateLlmOverrides(dto.llmOverrides);
    // TASK-659 — loop configuration + promotion surface. The single-PRIMARY
    // and always/never-overlap invariants are CROSS-FIELD, so they validate
    // the EFFECTIVE post-write state (dto value when supplied, else the
    // agent's current value) — a partial PATCH that only touches one side of
    // an invariant must still be checked against the other, unchanged side.
    if (dto.role !== undefined && dto.role !== agent.role) {
      await this.assertSinglePrimaryPerDepartment(tenantId, agent.departmentId, dto.role, id);
    }
    await this.validateSubscribedKinds(tenantId, agent.departmentId, dto.subscribedKinds);
    await this.validateWriteScope(tenantId, agent.departmentId, dto.writeScope);
    this.validateGoal(dto.goal);
    this.validateGuardrailProfile(dto.guardrailProfile);
    const effectiveAlwaysActions = dto.alwaysActions !== undefined ? dto.alwaysActions : (agent.alwaysActions ?? null);
    const effectiveNeverActions = dto.neverActions !== undefined ? dto.neverActions : (agent.neverActions ?? null);
    this.validateActionLists(effectiveAlwaysActions, effectiveNeverActions);

    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.slug !== undefined) agent.slug = dto.slug;
    if (dto.description !== undefined) agent.description = dto.description;
    if (dto.promptTemplateId !== undefined) agent.promptTemplateId = dto.promptTemplateId;
    if (dto.dnaStylePolicy !== undefined) agent.dnaStylePolicy = dto.dnaStylePolicy;
    if (dto.harnessOverrides !== undefined) agent.harnessOverrides = dto.harnessOverrides;
    if (dto.goldenSetId !== undefined) agent.goldenSetId = dto.goldenSetId;
    if (dto.newPatientTemplateId !== undefined) agent.newPatientTemplateId = dto.newPatientTemplateId;
    if (dto.revisitTemplateId !== undefined) agent.revisitTemplateId = dto.revisitTemplateId;
    if (dto.preSummaryTemplateId !== undefined) agent.preSummaryTemplateId = dto.preSummaryTemplateId;
    if (dto.livePromptTemplateId !== undefined) agent.livePromptTemplateId = dto.livePromptTemplateId;
    if (dto.toolConfig !== undefined) agent.toolConfig = dto.toolConfig;
    if (dto.llmOverrides !== undefined) agent.llmOverrides = dto.llmOverrides;
    if (dto.tags !== undefined) agent.tags = dto.tags;
    if (dto.role !== undefined) agent.role = dto.role;
    if (dto.subscribedKinds !== undefined) agent.subscribedKinds = dto.subscribedKinds;
    if (dto.writeScope !== undefined) agent.writeScope = dto.writeScope;
    if (dto.goal !== undefined) agent.goal = dto.goal;
    if (dto.guardrailProfile !== undefined) agent.guardrailProfile = dto.guardrailProfile;
    if (dto.alwaysActions !== undefined) agent.alwaysActions = dto.alwaysActions;
    if (dto.neverActions !== undefined) agent.neverActions = dto.neverActions;
    // `resourceStatus` is entity-managed via lifecycle methods (setters are
    // read-only on BaseEntity), mirroring PipelineService.toggle.
    if (dto.resourceStatus === ResourceStatusType.DISABLED && agent.resourceStatus !== ResourceStatusType.DISABLED) {
      agent.disable(userId ?? undefined);
    } else if (dto.resourceStatus === ResourceStatusType.ENABLED && agent.resourceStatus !== ResourceStatusType.ENABLED) {
      agent.enable(userId ?? undefined);
    }
    agent.updatedBy = userId ?? null;

    if (!agent.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = agent.version;
    const updated = await this.agentRepository.updateWithVersion(id, agent, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...agent.changes, previousVersion, newVersion: updated.version },
    });

    await this.writeLoopConfigVersionIfNeeded(updated);

    return DepartmentAgentDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<DepartmentAgentResponse> {
    const agent = await this.loadOwned(id);
    this.assertNotTemplateLocked(agent);

    const deleted = await this.agentRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: deleted.toObject() as object,
    });

    return DepartmentAgentDtoMapper.toResponse(deleted);
  }

  /**
   * Mark this agent as the department default. Atomic flip inside a single
   * transaction (`setDefaultForDepartment`) so "exactly one default per
   * department" is never observed half-applied. A scoped flag flip, not a
   * content edit — deliberately NOT OCC/If-Match guarded (mirrors pipelines).
   */
  async setDefault(id: string): Promise<DepartmentAgentResponse> {
    const tenantId = this.requireTenant();
    const userId = this.requestUserId;

    const agent = await this.loadOwned(id);

    await this.agentRepository.setDefaultForDepartment(tenantId, agent.departmentId, id, userId ?? undefined);

    const updated = (await this.agentRepository.findById(id)) ?? agent;

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { isDefault: true, slug: agent.slug, departmentId: agent.departmentId },
    });

    return DepartmentAgentDtoMapper.toResponse(updated);
  }

  /**
   * Pin (or unpin) the agent to a specific PromptVersion number. A pin content-
   * affecting change: `versionNumber` must reference an existing APPROVED-snapshot
   * PromptVersion of the bound template (null clears the pin). Version-bumped via
   * `updateWithVersion` so the ETag stays coherent, but not If-Match-gated.
   * Locked template copies reject a pin (403).
   */
  async pin(id: string, versionNumber: number | null): Promise<DepartmentAgentResponse> {
    const userId = this.requestUserId;

    const agent = await this.loadOwned(id);
    this.assertNotTemplateLocked(agent);

    if (versionNumber !== null) {
      const template = await this.promptTemplateRepository.findById(agent.promptTemplateId);
      if (!template) {
        throw new ArgumentInvalidException(`Bound prompt template ${agent.promptTemplateId} no longer exists`);
      }
      await this.assertPinnedVersionApproved(template, versionNumber);
    }

    agent.pinnedVersionNumber = versionNumber;
    agent.updatedBy = userId ?? null;

    if (!agent.hasChanges) {
      // Re-pinning to the same version is a no-op — return the current row.
      return DepartmentAgentDtoMapper.toResponse(agent);
    }

    // OD-3 eval promotion gate: re-pointing the pin to a NEW version (not an
    // unpin) with a golden set attached runs the eval BEFORE the pin lands. In
    // block-mode a failing eval rejects the re-point (409 + score payload); the
    // pin is not applied. The EvalRun is persisted (triggerType=PROMOTION) either way.
    if (this.promotionGate && versionNumber !== null && agent.goldenSetId) {
      const verdict = await this.promotionGate.evaluatePromotion({
        tenantId: agent.tenantId,
        promptTemplateId: agent.promptTemplateId,
        promptVersionNumber: versionNumber,
        agentId: id,
        trigger: 'pin',
      });
      if (verdict.blocked) {
        throw new ConflictException({
          message: 'Eval gate failed — agent pin re-point blocked.',
          reason: 'EVAL_GATE_FAILED',
          failures: verdict.failures,
          runIds: verdict.runIds,
          aggregates: verdict.aggregates,
        });
      }
    }

    const previousVersion = agent.version;
    const updated = await this.agentRepository.updateWithVersion(id, agent, agent.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { pinnedVersionNumber: versionNumber, previousVersion, newVersion: updated.version },
    });

    return DepartmentAgentDtoMapper.toResponse(updated);
  }

  /**
   * Clone an agent into a new, EDITABLE copy ("clone to customize" — the
   * sanctioned way to customize a LOCKED template copy). Mirrors
   * `PipelineService.clone` (TASK-531):
   *  - The bound PromptTemplate is DEEP-COPIED into a fresh tenant-owned
   *    template in DRAFT status (a v1 PromptVersion snapshot is written so the
   *    copy starts with an honest version history), carrying lineage in
   *    metadata back to the source template.
   *  - A new DepartmentAgent is created UNLOCKED (`templateLocked:false`), bound
   *    to that new editable template, tracking latest (`pinnedVersionNumber`
   *    null), NEVER the department default, and carrying `sourceAgentTemplateSlug`
   *    verbatim so provenance survives clone chains.
   *  - The source row (locked or not) is left completely untouched.
   *
   * The source is resolved through the tenant-ownership guard, so a cross-tenant
   * id surfaces as 404 (never leaks a foreign agent). This is what the console's
   * "clone to customize" (TASK-547) calls.
   */
  async clone(id: string, dto: CloneDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    const tenantId = this.requireTenant();
    const userId = this.requestUserId;

    const source = await this.loadOwned(id);

    // A clone is a NEW row: its slug must be unique within the department.
    const isUnique = await this.agentRepository.isSlugUnique(tenantId, source.departmentId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Department agent with slug '${dto.slug}' already exists in this department`);
    }

    // Deep-copy the bound template into an editable tenant-owned DRAFT copy.
    const sourceTemplate = await this.promptTemplateRepository.findById(source.promptTemplateId);
    if (!sourceTemplate) {
      throw new ArgumentInvalidException(`Bound prompt template ${source.promptTemplateId} no longer exists`);
    }

    const clonedTemplate = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: `${sourceTemplate.name ?? source.name} (Copy)`,
      description: sourceTemplate.description ?? undefined,
      content: sourceTemplate.content ?? undefined,
      category: sourceTemplate.category ?? undefined,
      // Editable copies start as DRAFT — the tenant customizes, then a global
      // admin approves before it resolves for clinical generation.
      status: 'DRAFT',
      variables: sourceTemplate.variables ?? undefined,
      departmentId: source.departmentId,
      scope: sourceTemplate.scope ?? undefined,
      currentVersionNumber: 1,
      tags: sourceTemplate.tags ?? [],
      createdBy: userId ?? undefined,
    });
    const savedTemplate = await this.promptTemplateRepository.create(clonedTemplate);

    const v1 = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: savedTemplate.id,
      versionNumber: 1,
      content: savedTemplate.content ?? undefined,
      variables: (savedTemplate.variables as Record<string, unknown> | null) ?? undefined,
      changeReason: `Cloned from template '${sourceTemplate.name ?? sourceTemplate.id}' via agent clone`,
      changedBy: userId ?? undefined,
      createdBy: userId ?? undefined,
    });
    await this.promptVersionRepository.create(v1);

    const agentClone = DepartmentAgentFactory.CreateDepartmentAgent({
      tenantId,
      departmentId: source.departmentId,
      name: dto.name,
      slug: dto.slug,
      description: source.description ?? null,
      promptTemplateId: savedTemplate.id,
      // The copy tracks the latest of ITS OWN new template.
      pinnedVersionNumber: null,
      dnaStylePolicy: source.dnaStylePolicy,
      harnessOverrides: source.harnessOverrides ?? null,
      goldenSetId: source.goldenSetId ?? null,
      // TASK-635 — capability bindings travel with the clone. Note the
      // ASYMMETRY with the BASE binding, which is deliberate: only
      // `promptTemplateId` is deep-copied into a fresh editable DRAFT template,
      // because that is the one the tenant customizes. The capability bindings
      // keep pointing at the SAME templates the source named, so a clone starts
      // out resolving identically. A tenant that wants to customize a capability
      // template edits/re-points that binding afterwards.
      newPatientTemplateId: source.newPatientTemplateId ?? null,
      revisitTemplateId: source.revisitTemplateId ?? null,
      preSummaryTemplateId: source.preSummaryTemplateId ?? null,
      livePromptTemplateId: source.livePromptTemplateId ?? null,
      toolConfig: source.toolConfig ?? null,
      llmOverrides: source.llmOverrides ?? null,
      // A clone is never the department default (the DB defaults `isDefault`
      // false; it is flipped only via `setDefaultForDepartment`).
      // The copy is the customizable one — never locked, whatever the source is;
      // provenance is carried verbatim (a copy-of-a-copy still reports its origin).
      templateLocked: false,
      sourceAgentTemplateSlug: source.sourceAgentTemplateSlug ?? null,
      tags: source.tags ?? [],
      createdBy: userId ?? undefined,
    });
    const savedAgent = await this.agentRepository.create(agentClone);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedAgent.id,
      createdAt: savedAgent.createdAt,
      data: {
        slug: savedAgent.slug,
        name: savedAgent.name,
        clonedFrom: source.id,
        promptTemplateId: savedAgent.promptTemplateId,
        sourceAgentTemplateSlug: savedAgent.sourceAgentTemplateSlug ?? null,
      },
    });

    return DepartmentAgentDtoMapper.toResponse(savedAgent);
  }

  // =========================================================================
  // Guards & validation
  // =========================================================================

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }

  /**
   * Load an agent and prove the caller owns it. Cross-tenant / missing both
   * surface as 404 (404-over-403 posture — never leak a foreign agent).
   */
  private async loadOwned(id: string): Promise<DepartmentAgentEntity> {
    const tenantId = this.requireTenant();
    const agent = await this.agentRepository.findById(id);
    if (!agent || agent.tenantId !== tenantId) {
      throw new NotFoundException(`Department agent ${id} not found`);
    }
    return agent;
  }

  /** The department must exist in the caller's tenant (else 404, no leak). */
  private async assertDepartmentInTenant(departmentId: string, tenantId: string): Promise<void> {
    const department = await this.departmentRepository.findById(departmentId);
    if (!department || department.tenantId !== tenantId) {
      throw new NotFoundException(`Department ${departmentId} not found`);
    }
  }

  /**
   * The bound template must be visible to the tenant (tenant-owned OR the
   * SYSTEM shared catalog) and, when it declares a department, that department
   * must match the agent's. Returns the template for downstream pin checks.
   */
  private async assertTemplateBindable(tenantId: string, promptTemplateId: string, departmentId: string): Promise<PromptTemplateEntity> {
    const template = await this.promptTemplateRepository.findById(promptTemplateId);
    // Generic 400 — do NOT confirm the existence of a cross-tenant template.
    if (!template || (template.tenantId !== tenantId && template.tenantId !== SYSTEM_TENANT_ID)) {
      throw new BadRequestException(`promptTemplateId '${promptTemplateId}' is not a valid template for this tenant`);
    }
    if (template.departmentId && template.departmentId !== departmentId) {
      throw new BadRequestException(`promptTemplateId '${promptTemplateId}' belongs to a different department`);
    }
    return template;
  }

  /**
   * Every capability binding present on the DTO must satisfy the SAME
   * bindability rule as the base `promptTemplateId`: tenant-visible (or the
   * SYSTEM shared catalogue) and department-compatible. Explicit `null` clears a
   * binding and is always allowed.
   *
   * Note this validates VISIBILITY, not APPROVAL: an unapproved binding is a
   * legal configuration that the resolver simply falls through (the tier returns
   * null). Rejecting it here would make it impossible to wire an agent to a
   * template that is still working its way through the approval gate.
   */
  private async assertCapabilityBindingsBindable(
    tenantId: string,
    departmentId: string,
    dto: Pick<CreateDepartmentAgentRequest, 'newPatientTemplateId' | 'revisitTemplateId' | 'preSummaryTemplateId' | 'livePromptTemplateId'>,
  ): Promise<void> {
    const bindings: Array<[string, string | null | undefined]> = [
      ['newPatientTemplateId', dto.newPatientTemplateId],
      ['revisitTemplateId', dto.revisitTemplateId],
      ['preSummaryTemplateId', dto.preSummaryTemplateId],
      ['livePromptTemplateId', dto.livePromptTemplateId],
    ];

    for (const [field, templateId] of bindings) {
      if (templateId === undefined || templateId === null) continue;
      try {
        await this.assertTemplateBindable(tenantId, templateId, departmentId);
      } catch {
        // Re-thrown against the FIELD so the console can highlight the right
        // control; the message stays generic (never confirms the existence of a
        // cross-tenant template).
        throw new BadRequestException(`${field} '${templateId}' is not a valid template for this tenant/department`);
      }
    }
  }

  /** `toolConfig` may name only known live-loop tools, with a known schema version. */
  private validateToolConfig(toolConfig?: Record<string, unknown> | null): void {
    if (!toolConfig) return;
    const problems = toolConfigProblems(toolConfig);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid toolConfig: ${problems.join('; ')}`);
    }
  }

  /**
   * `llmOverrides` may key only `live` / `finalize`, and each named model slug
   * must be an ENABLED TEXT_GENERATION `AiModel`. Validated at WRITE time so a
   * typo surfaces in the admin console rather than at 3am on a live flush; the
   * read path degrades gracefully (frozen selection falls back to the tenant
   * AiTaskDefault) for the case where a model is disabled after the fact.
   */
  private async validateLlmOverrides(llmOverrides?: Record<string, unknown> | null): Promise<void> {
    if (!llmOverrides) return;
    const { problems, slugs } = llmOverridesProblems(llmOverrides);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid llmOverrides: ${problems.join('; ')}`);
    }
    if (!this.aiModelRepository) return;

    for (const slug of slugs) {
      const model = await this.aiModelRepository.findBySlug(this.requireTenant(), slug);
      if (!model || model.taskType !== ModelTaskType.TEXT_GENERATION || model.resourceStatus !== ResourceStatusType.ENABLED) {
        throw new BadRequestException(`llmOverrides names '${slug}', which is not an enabled text-generation model`);
      }
    }
  }

  /** `harnessOverrides` may carry only tenant-tier HarnessPolicy keys. */
  private validateHarnessOverrides(overrides?: Record<string, unknown>): void {
    if (!overrides) return;
    const disallowed = disallowedHarnessOverrideKeys(overrides);
    if (disallowed.length > 0) {
      throw new BadRequestException(
        `harnessOverrides may only carry tenant-tier keys; the following are global-admin-only: ${disallowed.join(', ')}`,
      );
    }
  }

  /**
   * A pinnable version must exist for the bound template AND correspond to an
   * APPROVED snapshot. `PromptVersion` carries no per-snapshot status column, so
   * "APPROVED snapshot" is enforced as: the version row exists AND the template
   * is currently APPROVED (the same governance gate the resolution path uses;
   * approve() only pins snapshots while flipping to APPROVED).
   */
  private async assertPinnedVersionApproved(template: PromptTemplateEntity, versionNumber: number): Promise<void> {
    const version = await this.promptVersionRepository.findByVersionNumber(template.id, versionNumber);
    if (!version) {
      throw new ArgumentInvalidException(`pinnedVersionNumber ${versionNumber} does not exist for the bound template`);
    }
    if (template.status !== 'APPROVED') {
      throw new ArgumentInvalidException(
        `pinnedVersionNumber ${versionNumber} is not an APPROVED snapshot — the bound template is ${template.status}`,
      );
    }
  }

  /** Reject content mutation of a locked template copy. Call AFTER ownership. */
  private assertNotTemplateLocked(agent: { templateLocked?: boolean }): void {
    if (agent.templateLocked) {
      throw new ForbiddenException(AGENT_TEMPLATE_LOCKED_MESSAGE);
    }
  }

  // =========================================================================
  // TASK-659 — loop configuration + promotion surface
  // =========================================================================

  /** At most one ENABLED PRIMARY agent per department. */
  private async assertSinglePrimaryPerDepartment(
    tenantId: string,
    departmentId: string,
    role: DepartmentAgentRole | undefined,
    excludeId?: string,
  ): Promise<void> {
    if (role !== DepartmentAgentRole.PRIMARY) return;
    const existing = await this.agentRepository.findPrimaryForDepartment(tenantId, departmentId, excludeId);
    if (existing) {
      throw new BadRequestException(
        `Department ${departmentId} already has a PRIMARY agent ('${existing.slug}'); change its role before promoting another.`,
      );
    }
  }

  /**
   * `subscribedKinds` may reference only kind keys declared in the
   * department's resolved ConsultationContextSchemaVersion (TASK-658). When
   * the schema repositories are not wired into this service instance, only
   * the structural shape is checked (mirrors `validateLlmOverrides`'s
   * catalogue-check degradation).
   */
  private async validateSubscribedKinds(
    tenantId: string,
    departmentId: string,
    subscribedKinds?: Record<string, unknown> | null,
  ): Promise<void> {
    if (!subscribedKinds) return;
    const { problems, kindKeys } = subscribedKindsProblems(subscribedKinds);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid subscribedKinds: ${problems.join('; ')}`);
    }
    if (kindKeys.length === 0) return;

    const declared = await this.resolveServableContextDefinition(tenantId, departmentId);
    if (declared === undefined) return;
    if (declared === null) {
      throw new BadRequestException(
        `subscribedKinds names kind(s) ${kindKeys.join(', ')}, but this department has no published context schema to validate them against.`,
      );
    }
    const unknownKinds = kindKeys.filter((key) => !declared.kinds.has(key));
    if (unknownKinds.length > 0) {
      throw new BadRequestException(`subscribedKinds names unknown kind(s): ${unknownKinds.join(', ')}`);
    }
  }

  /** `writeScope` may reference only output keys declared in the resolved schema version. Same degradation as above. */
  private async validateWriteScope(tenantId: string, departmentId: string, writeScope?: Record<string, unknown> | null): Promise<void> {
    if (!writeScope) return;
    const { problems, outputKeys } = writeScopeProblems(writeScope);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid writeScope: ${problems.join('; ')}`);
    }
    if (outputKeys.length === 0) return;

    const declared = await this.resolveServableContextDefinition(tenantId, departmentId);
    if (declared === undefined) return;
    if (declared === null) {
      throw new BadRequestException(
        `writeScope names output(s) ${outputKeys.join(', ')}, but this department has no published context schema to validate them against.`,
      );
    }
    const unknownOutputs = outputKeys.filter((key) => !declared.outputs.has(key));
    if (unknownOutputs.length > 0) {
      throw new BadRequestException(`writeScope names undeclared output(s): ${unknownOutputs.join(', ')}`);
    }
  }

  /** `goal` is a constrained (not free-text) objective — see `goalProblems`. */
  private validateGoal(goal?: Record<string, unknown> | null): void {
    if (!goal) return;
    const problems = goalProblems(goal);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid goal: ${problems.join('; ')}`);
    }
  }

  /** `guardrailProfile` must name a profile from the closed catalogue. */
  private validateGuardrailProfile(guardrailProfile?: string | null): void {
    if (!guardrailProfile) return;
    const problems = guardrailProfileProblems(guardrailProfile);
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid guardrailProfile: ${problems.join('; ')}`);
    }
  }

  /** `alwaysActions`/`neverActions` — the D11 compliance envelope. Callers pass the EFFECTIVE post-write value (see call sites). */
  private validateActionLists(alwaysActions: string[] | null, neverActions: string[] | null): void {
    const problems: string[] = [];
    if (alwaysActions) problems.push(...actionListProblems(alwaysActions, 'alwaysActions'));
    if (neverActions) problems.push(...actionListProblems(neverActions, 'neverActions'));
    problems.push(...actionOverlapProblems(alwaysActions, neverActions));
    if (problems.length > 0) {
      throw new BadRequestException(`Invalid compliance envelope: ${problems.join('; ')}`);
    }
  }

  /**
   * The department's servable context-schema vocabulary (DEPARTMENT-scoped
   * default → TENANT-scoped default → none), mirroring
   * `ConsultationContextSchemaService`'s own discovery cascade. Three-way
   * result: `undefined` ⇒ the schema repositories are not wired into this
   * service instance (cross-check skipped); `null` ⇒ wired, but the
   * department has no servable schema (any referenced kind is therefore
   * unresolvable); an object ⇒ the declared kind/output keys.
   */
  private async resolveServableContextDefinition(
    tenantId: string,
    departmentId: string,
  ): Promise<{ kinds: Set<string>; outputs: Set<string> } | null | undefined> {
    if (!this.contextSchemaRepository || !this.contextSchemaVersionRepository) return undefined;

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

  /**
   * Write an immutable `DepartmentAgentVersion` snapshot of the seven
   * loop-config fields when at least one is set AND the snapshot differs from
   * the latest recorded one (a no-op write moves nothing — mirrors
   * `ConsultationContextSchemaService.publish`'s idempotent-republish guard).
   * No-op when `agentVersionRepository` is not wired (existing unit fixtures).
   */
  private async writeLoopConfigVersionIfNeeded(agent: DepartmentAgentEntity): Promise<void> {
    if (!this.agentVersionRepository) return;

    const snapshot = buildLoopConfigSnapshot(agent);
    if (!hasLoopConfig(snapshot)) return;

    const checksum = createHash('sha256').update(canonicalConfigJson(snapshot)).digest('hex');
    const latest = await this.agentVersionRepository.findLatestForAgent(agent.id);
    if (latest && latest.checksum === checksum) return;

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({
      tenantId: agent.tenantId,
      agentId: agent.id,
      versionNumber,
      configSnapshot: snapshot as never,
      checksum,
      createdBy: this.requestUserId ?? undefined,
    });
    await this.agentVersionRepository.create(version);
  }
}

/**
 * Deterministic (key-sorted, array-order-preserved) serialization for the
 * loop-config checksum — the same shape as `context-schema-definition.ts`'s
 * `canonicalJson`, kept as an independent local copy so this file has no
 * cross-service dependency (mirrors that file's own relationship to
 * `harnessAuditHash.ts`'s canonicalJson — a third, deliberately separate copy).
 */
function canonicalConfigJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfigJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalConfigJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The seven loop-config fields, snapshotted verbatim. */
function buildLoopConfigSnapshot(agent: DepartmentAgentEntity): Record<string, unknown> {
  return {
    role: agent.role,
    subscribedKinds: agent.subscribedKinds ?? null,
    writeScope: agent.writeScope ?? null,
    goal: agent.goal ?? null,
    guardrailProfile: agent.guardrailProfile ?? null,
    alwaysActions: agent.alwaysActions ?? null,
    neverActions: agent.neverActions ?? null,
  };
}

/** True when the agent actually configures the loop surface — SPECIALIST + all-null is "nothing configured, don't version it". */
function hasLoopConfig(snapshot: Record<string, unknown>): boolean {
  return (
    snapshot.role !== DepartmentAgentRole.SPECIALIST ||
    snapshot.subscribedKinds !== null ||
    snapshot.writeScope !== null ||
    snapshot.goal !== null ||
    snapshot.guardrailProfile !== null ||
    (Array.isArray(snapshot.alwaysActions) && snapshot.alwaysActions.length > 0) ||
    (Array.isArray(snapshot.neverActions) && snapshot.neverActions.length > 0)
  );
}

/** Every declared `kinds[].key` / `outputs[].key` in a ConsultationContextSchemaVersion `definition` document. */
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
