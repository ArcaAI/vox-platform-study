import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentAssignmentChangeFactory,
  AgentAssignmentChangeRepository,
  AgentAssignmentEntity,
  AgentAssignmentFactory,
  AgentAssignmentRepository,
  AgentRepository,
  AgentTask,
  CoreDatabaseService,
  DepartmentRepository,
  PipelinePolicyScope,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { agentTagProblems, agentTagsSatisfy, canonicalAgentTags } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { AgentAssignmentResponse, UpsertAgentAssignmentRequest } from './dto';
import { AgentAssignmentSource, IAgentAssignmentService, ResolvedAgentAssignment } from './IAgentAssignmentService';
import { AgentAssignmentDtoMapper } from './agent-assignment.dto.mapper';

/** The tiers this ticket exposes (DOCTOR is expressible but rejected — the WorkflowAssignment call). */
const WRITABLE_SCOPES: ReadonlySet<PipelinePolicyScope> = new Set([PipelinePolicyScope.TENANT, PipelinePolicyScope.DEPARTMENT]);

/**
 * WHICH agent serves a task for a scope (TASK-863) — the `WorkflowAssignmentService` shape:
 * OCC-guarded CRUD with referential validation at WRITE time, and `resolve()`, the
 * `department → tenant → null` walk.
 *
 * TASK-890 OD-M — the walk USED to end at the SYSTEM tenant's TENANT-scope row, and no longer
 * does. An agent and its assignment are CONTENT (§1.5): SYSTEM holds the REFERENCE SET a tenant
 * is provisioned from, not a tier it resolves through, so the platform default reaches a tenant
 * as the tenant's OWN cloned row. A tenant with nothing assigned resolves `unassigned`, and its
 * callers raise `AGENT_NOT_ASSIGNED` naming the task and the tenant — a named, fail-closed
 * error, never a silent read of somebody else's row.
 */
@Injectable()
export class AgentAssignmentService extends BaseService implements IAgentAssignmentService {
  private readonly logger = new Logger(AgentAssignmentService.name);

  constructor(
    private readonly assignmentRepository: AgentAssignmentRepository,
    private readonly changeRepository: AgentAssignmentChangeRepository,
    private readonly agentRepository: AgentRepository,
    private readonly departmentRepository: DepartmentRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AgentAssignment);
  }

  // ---------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------

  async resolve(
    tenantId: string,
    task: AgentTask,
    departmentId?: string | null,
    selectorTags: readonly string[] = [],
  ): Promise<ResolvedAgentAssignment> {
    const requestTags = canonicalAgentTags([...selectorTags]);
    const candidates: Array<{ source: AgentAssignmentSource; slug: string; selector: string[] }> = [];

    // TIER order: department → tenant. There is no third tier (TASK-890 OD-M). WITHIN each
    // tier, TASK-884's selector applies: the rows whose `key:value` selector is a SUBSET of the
    // request's tags, most specific first, unqualified last — so a request carrying no tags
    // sees exactly the one unqualified row each tier always had.
    if (departmentId) {
      candidates.push(...(await this.tierCandidates(tenantId, PipelinePolicyScope.DEPARTMENT, departmentId, task, requestTags, 'department')));
    }
    candidates.push(...(await this.tierCandidates(tenantId, PipelinePolicyScope.TENANT, null, task, requestTags, 'tenant')));

    // First-match-wins, but a matched row must also RESOLVE: an assignment is a reference and a
    // reference can rot (the agent was deprecated or deleted since). Skip it with a warning
    // and keep walking — never serve a stale slug, never silently substitute one either.
    for (const candidate of candidates) {
      const published = await this.agentRepository.findPublishedActiveBySlug(tenantId, candidate.slug);
      if (published && published.task === task) {
        return { agentSlug: candidate.slug, source: candidate.source, selector: candidate.selector };
      }
      this.logger.warn({
        message: 'Agent assignment points at a slug with no ACTIVE PUBLISHED agent of this task — skipping this tier',
        tenantId,
        task,
        departmentId: departmentId ?? null,
        agentSlug: candidate.slug,
        assignedAt: candidate.source,
        selector: candidate.selector,
      });
    }
    // Fail CLOSED and say so. `unassigned` is not "the platform will handle it" — after
    // TASK-890 L13 step v there is no platform tier to fall through to, so every caller turns
    // this into `AGENT_NOT_ASSIGNED { task, tenantId, departmentId }` and the remedy is the
    // tenant's own assignment (or a reference-set re-sync).
    this.logger.warn({
      message: 'No agent is assigned for this task in this tenant',
      code: 'AGENT_NOT_ASSIGNED',
      tenantId,
      task,
      departmentId: departmentId ?? null,
    });
    return { agentSlug: null, source: 'unassigned', selector: [] };
  }

  /**
   * One tier's rows that the request's tags SATISFY, ordered most specific first.
   *
   * Specificity is the selector's length, and ties are broken by the canonical selector string
   * so the order is total and deterministic — two equally specific selectors must not resolve
   * differently between two identical requests.
   */
  private async tierCandidates(
    tenantId: string,
    scope: PipelinePolicyScope,
    scopeId: string | null,
    task: AgentTask,
    requestTags: readonly string[],
    source: AgentAssignmentSource,
  ): Promise<Array<{ source: AgentAssignmentSource; slug: string; selector: string[] }>> {
    const rows = await this.assignmentRepository.findAllForScope(tenantId, scope, scopeId, task);
    return rows
      .map((row) => ({ row, selector: row.selectorKey ? row.selectorKey.split(',') : [] }))
      .filter(({ selector }) => agentTagsSatisfy(requestTags, selector))
      .sort((a, b) => b.selector.length - a.selector.length || a.row.selectorKey.localeCompare(b.row.selectorKey))
      .map(({ row, selector }) => ({ source, slug: row.agentSlug, selector }));
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------

  async list(task?: AgentTask): Promise<AgentAssignmentResponse[]> {
    const tenantId = this.requireTenant();
    const rows = await this.assignmentRepository.findAllVisible(tenantId, task);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { task: task ?? null, count: rows.length } });
    return rows.map(AgentAssignmentDtoMapper.toResponse);
  }

  async getById(id: string): Promise<AgentAssignmentResponse> {
    const entity = await this.loadOwned(id);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });
    return AgentAssignmentDtoMapper.toResponse(entity);
  }

  /** Create or replace the assignment for one `(scope, scopeId, task)` tier; row edit + WORM change row in ONE transaction. */
  async upsert(dto: UpsertAgentAssignmentRequest, expectedVersion?: number): Promise<AgentAssignmentResponse> {
    const tenantId = this.requireTenant();
    const scope = dto.scope;
    const scopeId = scope === PipelinePolicyScope.TENANT ? null : (dto.scopeId ?? null);

    if (!WRITABLE_SCOPES.has(scope)) {
      throw new BadRequestException(`Agent assignments support TENANT and DEPARTMENT scope only, not ${scope}.`);
    }
    if (scope === PipelinePolicyScope.DEPARTMENT && !scopeId) {
      throw new BadRequestException('A DEPARTMENT-scope assignment requires scopeId (the department id).');
    }

    await this.assertDepartmentInTenant(scope, scopeId);
    await this.assertSlugPublished(tenantId, dto.task, dto.agentSlug);

    // TASK-884 — the selector is part of the row's IDENTITY, not one of its editable fields:
    // it is in the uniqueness key, so a different selector addresses a DIFFERENT assignment.
    // Canonicalising here is what makes `{a,b}` and `{b,a}` one row rather than two rows
    // competing for the same tier.
    const selectorKey = this.canonicalSelector(dto.selectorTags);

    const changedBy = this.requestUserId ?? null;
    const reason = dto.reason ?? null;
    const existing = await this.assignmentRepository.findForScopeSelector(tenantId, scope, scopeId, dto.task, selectorKey);

    if (existing) {
      const beforeSlug = existing.agentSlug;
      existing.agentSlug = dto.agentSlug;
      this.assertExpectedVersion(existing, expectedVersion ?? dto.expectedVersion);
      if (!existing.hasChanges) {
        return AgentAssignmentDtoMapper.toResponse(existing);
      }
      existing.updatedBy = changedBy;
      existing.validate();

      const casVersion = expectedVersion ?? dto.expectedVersion ?? existing.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const saved = await this.assignmentRepository.updateWithVersion(existing.id, existing, casVersion, tx);
        await this.appendChange(
          { tenantId, scope, scopeId, task: dto.task, selectorKey, changedBy, reason },
          { beforeSlug, afterSlug: saved.agentSlug, assignmentVersion: saved.version },
          tx,
        );
        return saved;
      });

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: { previousVersion: casVersion, newVersion: updated.version, beforeSlug, afterSlug: updated.agentSlug },
      });
      return AgentAssignmentDtoMapper.toResponse(updated);
    }

    const entity = AgentAssignmentFactory.CreateAgentAssignment({
      tenantId,
      scope,
      scopeId,
      task: dto.task,
      agentSlug: dto.agentSlug,
      selectorKey,
      createdBy: changedBy,
    });
    entity.validate();

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const saved = await this.assignmentRepository.create(entity, tx);
      await this.appendChange(
        { tenantId, scope, scopeId, task: dto.task, selectorKey, changedBy, reason },
        { beforeSlug: null, afterSlug: saved.agentSlug, assignmentVersion: saved.version },
        tx,
      );
      return saved;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      data: { scope, scopeId, task: created.task, agentSlug: created.agentSlug, selectorKey },
    });
    return AgentAssignmentDtoMapper.toResponse(created);
  }

  async remove(id: string, expectedVersion?: number, reason?: string | null): Promise<AgentAssignmentResponse> {
    const entity = await this.loadOwned(id);
    const changedBy = this.requestUserId ?? null;

    const removed = await this.databaseService.baseClient.$transaction(async (tx) => {
      const deleted = await this.assignmentRepository.softDelete(entity.id, changedBy ?? undefined, tx);
      await this.appendChange(
        {
          tenantId: entity.tenantId,
          scope: entity.scope,
          scopeId: entity.scopeId ?? null,
          task: entity.task,
          selectorKey: entity.selectorKey,
          changedBy,
          reason: reason ?? null,
        },
        { beforeSlug: entity.agentSlug, afterSlug: null, assignmentVersion: deleted?.version ?? entity.version },
        tx,
      );
      return deleted ?? entity;
    });

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: entity.id,
      data: { expectedVersion: expectedVersion ?? null, beforeSlug: entity.agentSlug },
    });
    return AgentAssignmentDtoMapper.toResponse(removed);
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

  /** 404-over-403: a foreign (or SYSTEM) row is indistinguishable from a missing one for a write. */
  private async loadOwned(id: string): Promise<AgentAssignmentEntity> {
    const tenantId = this.requireTenant();
    const entity = await this.assignmentRepository.findById(id).catch(() => null);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException('Agent assignment not found');
    }
    return entity;
  }

  /**
   * The stored form of a selector: validated against the `key:value` grammar, de-duplicated,
   * sorted and comma-joined. A bare key is REFUSED rather than dropped — a silently dropped tag
   * changes which assignment the row is, and therefore which agent a request resolves.
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
    const department = await this.departmentRepository.findById(scopeId).catch(() => null);
    if (!department || department.tenantId !== tenantId) {
      throw new NotFoundException('Department not found');
    }
  }

  private async assertSlugPublished(tenantId: string, task: AgentTask, slug: string): Promise<void> {
    const published = await this.agentRepository.findPublishedActiveBySlug(tenantId, slug);
    if (!published || published.task !== task) {
      throw new BadRequestException(`No ACTIVE PUBLISHED ${task} agent with slug '${slug}' is visible to this tenant.`);
    }
  }

  private async appendChange(
    key: {
      tenantId: string;
      scope: PipelinePolicyScope;
      scopeId: string | null;
      task: AgentTask;
      selectorKey: string;
      changedBy: string | null;
      reason: string | null;
    },
    delta: { beforeSlug: string | null; afterSlug: string | null; assignmentVersion: number },
    tx: unknown,
  ): Promise<void> {
    await this.changeRepository.create(
      AgentAssignmentChangeFactory.CreateAgentAssignmentChange({
        tenantId: key.tenantId,
        scope: key.scope,
        scopeId: key.scopeId,
        task: key.task,
        selectorKey: key.selectorKey,
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
