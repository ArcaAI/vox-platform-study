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
 * `department → tenant → SYSTEM` walk. The SYSTEM tenant's TENANT-scope row IS the platform
 * default (rule 00: two tiers, request tenant → SYSTEM; `50000000-…` never appears here).
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

  async resolve(tenantId: string, task: AgentTask, departmentId?: string | null): Promise<ResolvedAgentAssignment> {
    const tiers: Array<{ source: AgentAssignmentSource; slug: string | null }> = [];

    if (departmentId) {
      const row = await this.assignmentRepository.findForScope(tenantId, PipelinePolicyScope.DEPARTMENT, departmentId, task);
      tiers.push({ source: 'department', slug: row?.agentSlug ?? null });
    }
    const tenantRow = await this.assignmentRepository.findForScope(tenantId, PipelinePolicyScope.TENANT, null, task);
    tiers.push({ source: 'tenant', slug: tenantRow?.agentSlug ?? null });

    if (tenantId !== SYSTEM_TENANT_ID) {
      const systemRow = await this.assignmentRepository.findForScope(SYSTEM_TENANT_ID, PipelinePolicyScope.TENANT, null, task);
      tiers.push({ source: 'platform-default', slug: systemRow?.agentSlug ?? null });
    }

    // First-set-wins, but a set tier must also RESOLVE: an assignment is a reference and a
    // reference can rot (the agent was deprecated or deleted since). Skip it with a warning
    // and keep walking — never serve a stale slug, never silently substitute one either.
    for (const tier of tiers) {
      if (tier.slug === null) continue;
      const published = await this.agentRepository.findPublishedActiveBySlug(tenantId, tier.slug);
      if (published && published.task === task) {
        return { agentSlug: tier.slug, source: tier.source };
      }
      this.logger.warn({
        message: 'Agent assignment points at a slug with no ACTIVE PUBLISHED agent of this task — skipping this tier',
        tenantId,
        task,
        departmentId: departmentId ?? null,
        agentSlug: tier.slug,
        assignedAt: tier.source,
      });
    }
    return { agentSlug: null, source: 'platform-default' };
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

    const changedBy = this.requestUserId ?? null;
    const reason = dto.reason ?? null;
    const existing = await this.assignmentRepository.findForScope(tenantId, scope, scopeId, dto.task);

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
          { tenantId, scope, scopeId, task: dto.task, changedBy, reason },
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
      createdBy: changedBy,
    });
    entity.validate();

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const saved = await this.assignmentRepository.create(entity, tx);
      await this.appendChange(
        { tenantId, scope, scopeId, task: dto.task, changedBy, reason },
        { beforeSlug: null, afterSlug: saved.agentSlug, assignmentVersion: saved.version },
        tx,
      );
      return saved;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      data: { scope, scopeId, task: created.task, agentSlug: created.agentSlug },
    });
    return AgentAssignmentDtoMapper.toResponse(created);
  }

  async remove(id: string, expectedVersion?: number, reason?: string | null): Promise<AgentAssignmentResponse> {
    const entity = await this.loadOwned(id);
    const changedBy = this.requestUserId ?? null;

    const removed = await this.databaseService.baseClient.$transaction(async (tx) => {
      const deleted = await this.assignmentRepository.softDelete(entity.id, changedBy ?? undefined, tx);
      await this.appendChange(
        { tenantId: entity.tenantId, scope: entity.scope, scopeId: entity.scopeId ?? null, task: entity.task, changedBy, reason: reason ?? null },
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
    key: { tenantId: string; scope: PipelinePolicyScope; scopeId: string | null; task: AgentTask; changedBy: string | null; reason: string | null },
    delta: { beforeSlug: string | null; afterSlug: string | null; assignmentVersion: number },
    tx: unknown,
  ): Promise<void> {
    await this.changeRepository.create(
      AgentAssignmentChangeFactory.CreateAgentAssignmentChange({
        tenantId: key.tenantId,
        scope: key.scope,
        scopeId: key.scopeId,
        task: key.task,
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
