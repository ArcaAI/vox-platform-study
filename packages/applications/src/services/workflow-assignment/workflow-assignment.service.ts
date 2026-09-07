import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
  DepartmentRepository,
  PipelinePolicyScope,
  ResourceType,
  SysEventType,
  WorkflowAssignmentChangeFactory,
  WorkflowAssignmentChangeRepository,
  WorkflowAssignmentEntity,
  WorkflowAssignmentFactory,
  WorkflowAssignmentRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { agentTagProblems, agentTagsSatisfy, canonicalAgentTags, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UpsertWorkflowAssignmentRequest, WorkflowAssignmentResponse } from './dto';
import { IWorkflowAssignmentService, ResolvedWorkflowAssignment, WorkflowAssignmentSource } from './IWorkflowAssignmentService';
import { WorkflowAssignmentDtoMapper } from './workflow-assignment.dto.mapper';

/**
 * The palettes a definition may target, derived from the code-owned node
 * registry rather than re-declared here — `paletteKey` is never a free string
 * at the API boundary (the same call `WorkflowDefinitionService` makes for
 * graphs). A palette with no registered node types cannot be assigned, which
 * is the fail-closed answer, not a gap.
 */
function registeredPalettes(): ReadonlySet<string> {
  return new Set(
    Object.values(WORKFLOW_NODE_REGISTRY)
      .map((descriptor) => descriptor.paletteKey)
      .filter((key): key is string => typeof key === 'string'),
  );
}

/**
 * The tiers this ticket exposes. DOCTOR is structurally supported by the cascade
 * but is a product decision nobody has made (so it is rejected.
 */
const WRITABLE_SCOPES: ReadonlySet<PipelinePolicyScope> = new Set([PipelinePolicyScope.TENANT, PipelinePolicyScope.DEPARTMENT]);

/**
 * WHICH workflow definition governs a scope for a palette.
 *
 * Two responsibilities: OCC-guarded CRUD with referential validation at WRITE
 * time, and `resolve()` — the `department → tenant → platform default` walk.
 * TASK-891 adds an optional TAG SELECTOR within the department/tenant tiers
 * (mirrors `AgentAssignmentService`'s TASK-884 selector), so the platform
 * default remains the ONLY tier `walkCascade` would still describe; the two
 * real tiers are now walked candidate-by-candidate here instead.
 */
@Injectable()
export class WorkflowAssignmentService extends BaseService implements IWorkflowAssignmentService {
  private readonly logger = new Logger(WorkflowAssignmentService.name);

  constructor(
    private readonly assignmentRepository: WorkflowAssignmentRepository,
    private readonly changeRepository: WorkflowAssignmentChangeRepository,
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly departmentRepository: DepartmentRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowAssignment);
  }

  // ---------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------

  async resolve(
    tenantId: string,
    paletteKey: string,
    departmentId?: string | null,
    selectorTags: readonly string[] = [],
  ): Promise<ResolvedWorkflowAssignment> {
    const requestTags = canonicalAgentTags([...selectorTags]);
    const candidates: Array<{ source: WorkflowAssignmentSource; slug: string; selector: string[] }> = [];

    // TIER order: department → tenant → platform default. WITHIN each tier, TASK-891's
    // selector applies (mirrors AgentAssignmentService.resolve's TASK-884 walk): the rows
    // whose `key:value` selector is a SUBSET of the request's tags, most specific first,
    // unqualified last — so a request carrying no tags sees exactly the one unqualified
    // row each tier always had.
    if (departmentId) {
      candidates.push(...(await this.tierCandidates(tenantId, PipelinePolicyScope.DEPARTMENT, departmentId, paletteKey, requestTags, 'department')));
    }
    candidates.push(...(await this.tierCandidates(tenantId, PipelinePolicyScope.TENANT, null, paletteKey, requestTags, 'tenant')));

    // First-match-wins, but a matched row must also RESOLVE: an assignment is a REFERENCE
    // and a reference can rot (the definition was deprecated or soft-deleted since). Skip
    // it with a warning and keep walking — never serve a stale slug, never silently
    // substitute one either.
    for (const candidate of candidates) {
      const published = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, candidate.slug);
      if (published && published.paletteKey === paletteKey) {
        return { workflowDefinitionSlug: candidate.slug, source: candidate.source, selector: candidate.selector };
      }
      this.logger.warn({
        message: 'Workflow assignment points at a slug with no ACTIVE PUBLISHED definition — skipping this tier',
        tenantId,
        paletteKey,
        departmentId: departmentId ?? null,
        workflowDefinitionSlug: candidate.slug,
        assignedAt: candidate.source,
        selector: candidate.selector,
      });
    }

    // `null` is the code default: NO tier assigned anything resolvable, so the caller
    // keeps its own platform-default resolution. Falling back to it is the declared last
    // tier, not a silent substitution.
    return { workflowDefinitionSlug: null, source: 'platform-default', selector: [] };
  }

  /**
   * One tier's rows that the request's tags SATISFY, ordered most specific first.
   *
   * Specificity is the selector's length, and ties are broken by the canonical selector
   * string so the order is total and deterministic — two equally specific selectors must
   * not resolve differently between two identical requests. Mirrors
   * `AgentAssignmentService.tierCandidates` (TASK-884).
   */
  private async tierCandidates(
    tenantId: string,
    scope: PipelinePolicyScope,
    scopeId: string | null,
    paletteKey: string,
    requestTags: readonly string[],
    source: WorkflowAssignmentSource,
  ): Promise<Array<{ source: WorkflowAssignmentSource; slug: string; selector: string[] }>> {
    const rows = await this.assignmentRepository.findAllForScope(tenantId, scope, scopeId, paletteKey);
    return rows
      .map((row) => ({ row, selector: row.selectorKey ? row.selectorKey.split(',') : [] }))
      .filter(({ selector }) => agentTagsSatisfy(requestTags, selector))
      .sort((a, b) => b.selector.length - a.selector.length || a.row.selectorKey.localeCompare(b.row.selectorKey))
      .map(({ row, selector }) => ({ source, slug: row.workflowDefinitionSlug, selector }));
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------

  async listForPalette(paletteKey: string): Promise<WorkflowAssignmentResponse[]> {
    const tenantId = this.requireTenant();
    const rows = await this.assignmentRepository.findAllForPalette(tenantId, paletteKey);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { paletteKey, count: rows.length } });

    return rows.map(WorkflowAssignmentDtoMapper.toResponse);
  }

  async getById(id: string): Promise<WorkflowAssignmentResponse> {
    const entity = await this.loadOwned(id);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });
    return WorkflowAssignmentDtoMapper.toResponse(entity);
  }

  /**
   * Create or replace the assignment for one `(scope, scopeId, paletteKey)`
   * tier. The row edit and its WORM change record commit in ONE transaction —
   * an assignment is never changed without its audit row, and vice versa
   * (the contract the retired `PipelinePolicyService.upsertRow` established).
   */
  async upsert(dto: UpsertWorkflowAssignmentRequest, expectedVersion?: number): Promise<WorkflowAssignmentResponse> {
    const tenantId = this.requireTenant();
    const scope = dto.scope;
    const scopeId = scope === PipelinePolicyScope.TENANT ? null : (dto.scopeId ?? null);

    if (!WRITABLE_SCOPES.has(scope)) {
      throw new BadRequestException(`Workflow assignments support TENANT and DEPARTMENT scope only, not ${scope}.`);
    }
    if (scope === PipelinePolicyScope.DEPARTMENT && !scopeId) {
      throw new BadRequestException('A DEPARTMENT-scope assignment requires scopeId (the department id).');
    }
    if (!registeredPalettes().has(dto.paletteKey)) {
      throw new BadRequestException(`Unknown palette '${dto.paletteKey}'.`);
    }

    await this.assertDepartmentInTenant(scope, scopeId);
    await this.assertSlugPublished(tenantId, dto.paletteKey, dto.workflowDefinitionSlug);

    // TASK-891 — the selector is part of the row's IDENTITY, not one of its editable
    // fields: it is in the uniqueness key, so a different selector addresses a DIFFERENT
    // assignment. Canonicalising here is what makes `{a,b}` and `{b,a}` one row rather
    // than two rows competing for the same tier (mirrors `AgentAssignmentService.upsert`).
    const selectorKey = this.canonicalSelector(dto.selectorTags);

    const changedBy = this.requestUserId ?? null;
    const reason = dto.reason ?? null;
    const existing = await this.assignmentRepository.findForScopeSelector(tenantId, scope, scopeId, dto.paletteKey, selectorKey);

    if (existing) {
      const beforeSlug = existing.workflowDefinitionSlug;
      existing.workflowDefinitionSlug = dto.workflowDefinitionSlug;
      // OCC precondition BEFORE the no-changes short-circuit: a stale client must
      // get 412 ("you are stale, refetch"), not 400/200, even when the payload
      // would change nothing. RFC 7232 evaluates preconditions independently of
      // the payload; the CAS below still guards concurrent writers.
      this.assertExpectedVersion(existing, expectedVersion ?? dto.expectedVersion);
      if (!existing.hasChanges) {
        return WorkflowAssignmentDtoMapper.toResponse(existing); // idempotent no-op — nothing to write or audit.
      }
      existing.updatedBy = changedBy;
      existing.validate();

      const casVersion = expectedVersion ?? dto.expectedVersion ?? existing.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const saved = await this.assignmentRepository.updateWithVersion(existing.id, existing, casVersion, tx);
        await this.appendChange(
          { tenantId, scope, scopeId, paletteKey: dto.paletteKey, changedBy, reason },
          { beforeSlug, afterSlug: saved.workflowDefinitionSlug, assignmentVersion: saved.version },
          tx,
        );
        return saved;
      });

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: { previousVersion: casVersion, newVersion: updated.version, beforeSlug, afterSlug: updated.workflowDefinitionSlug },
      });
      return WorkflowAssignmentDtoMapper.toResponse(updated);
    }

    const entity = WorkflowAssignmentFactory.CreateWorkflowAssignment({
      tenantId,
      scope,
      scopeId,
      paletteKey: dto.paletteKey,
      workflowDefinitionSlug: dto.workflowDefinitionSlug,
      selectorKey,
      createdBy: changedBy,
    });
    entity.validate();

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const saved = await this.assignmentRepository.create(entity, tx);
      await this.appendChange(
        { tenantId, scope, scopeId, paletteKey: dto.paletteKey, changedBy, reason },
        { beforeSlug: null, afterSlug: saved.workflowDefinitionSlug, assignmentVersion: saved.version },
        tx,
      );
      return saved;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      data: { scope, scopeId, paletteKey: created.paletteKey, workflowDefinitionSlug: created.workflowDefinitionSlug, selectorKey },
    });
    return WorkflowAssignmentDtoMapper.toResponse(created);
  }

  /** Soft-delete one assignment — the tier reverts to inheriting. Appends a
   *  change row with a null `afterSlug`. */
  async remove(id: string, expectedVersion?: number, reason?: string | null): Promise<WorkflowAssignmentResponse> {
    const entity = await this.loadOwned(id);
    const changedBy = this.requestUserId ?? null;

    const removed = await this.databaseService.baseClient.$transaction(async (tx) => {
      const deleted = await this.assignmentRepository.softDelete(entity.id, changedBy ?? undefined, tx);
      await this.appendChange(
        {
          tenantId: entity.tenantId,
          scope: entity.scope,
          scopeId: entity.scopeId ?? null,
          paletteKey: entity.paletteKey,
          changedBy,
          reason: reason ?? null,
        },
        { beforeSlug: entity.workflowDefinitionSlug, afterSlug: null, assignmentVersion: deleted?.version ?? entity.version },
        tx,
      );
      return deleted ?? entity;
    });

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: entity.id,
      data: { expectedVersion: expectedVersion ?? null, beforeSlug: entity.workflowDefinitionSlug },
    });
    return WorkflowAssignmentDtoMapper.toResponse(removed);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }

  /** 404-over-403: a foreign tenant's id is indistinguishable from a missing one. */
  private async loadOwned(id: string): Promise<WorkflowAssignmentEntity> {
    const tenantId = this.requireTenant();
    const entity = await this.assignmentRepository.findById(id);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException('Workflow assignment not found');
    }
    return entity;
  }

  /**
   * The stored form of a selector: validated against the `key:value` grammar, de-duplicated,
   * sorted and comma-joined. A bare key is REFUSED rather than dropped — a silently dropped
   * tag changes which assignment the row is, and therefore which workflow a request
   * resolves. Mirrors `AgentAssignmentService.canonicalSelector` (TASK-884).
   */
  private canonicalSelector(selectorTags?: readonly string[]): string {
    if (!selectorTags || selectorTags.length === 0) return '';
    const problems = agentTagProblems([...selectorTags], 'selectorTags');
    if (problems.length > 0) {
      throw new BadRequestException({ message: 'An assignment selector must be `key:value` tags.', code: 'TAG_GRAMMAR', findings: problems });
    }
    return canonicalAgentTags([...selectorTags]).join(',');
  }

  private async assertDepartmentInTenant(scope: PipelinePolicyScope, scopeId: string | null): Promise<void> {
    if (scope !== PipelinePolicyScope.DEPARTMENT || !scopeId) return;
    const tenantId = this.requireTenant();
    const department = await this.departmentRepository.findById(scopeId);
    if (!department || department.tenantId !== tenantId) {
      throw new NotFoundException('Department not found');
    }
  }

  private async assertSlugPublished(tenantId: string, paletteKey: string, slug: string): Promise<void> {
    const published = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!published || published.paletteKey !== paletteKey) {
      throw new BadRequestException(`No PUBLISHED '${paletteKey}' workflow definition with slug '${slug}'.`);
    }
  }

  private async appendChange(
    key: {
      tenantId: string;
      scope: PipelinePolicyScope;
      scopeId: string | null;
      paletteKey: string;
      changedBy: string | null;
      reason: string | null;
    },
    delta: { beforeSlug: string | null; afterSlug: string | null; assignmentVersion: number },
    tx: unknown,
  ): Promise<void> {
    await this.changeRepository.create(
      WorkflowAssignmentChangeFactory.CreateWorkflowAssignmentChange({
        tenantId: key.tenantId,
        scope: key.scope,
        scopeId: key.scopeId,
        paletteKey: key.paletteKey,
        changedBy: key.changedBy,
        assignmentVersion: delta.assignmentVersion,
        beforeSlug: delta.beforeSlug,
        afterSlug: delta.afterSlug,
        reason: key.reason,
        createdBy: key.changedBy,
      }),
      tx,
    );
  }
}
