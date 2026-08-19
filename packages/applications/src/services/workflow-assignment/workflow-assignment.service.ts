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
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { CascadeTier, walkCascade } from '../settings-registry/scope-cascade';
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

/** The tiers this ticket exposes. DOCTOR is structurally supported by the cascade
 *  but is a product decision nobody has made (TASK-733 §1.4), so it is rejected. */
const WRITABLE_SCOPES: ReadonlySet<PipelinePolicyScope> = new Set([PipelinePolicyScope.TENANT, PipelinePolicyScope.DEPARTMENT]);

/**
 * WHICH workflow definition governs a scope for a palette (TASK-733 half (a)).
 *
 * Two responsibilities: OCC-guarded CRUD with referential validation at WRITE
 * time, and `resolve()` — the `department → tenant → platform default` walk,
 * delegated to the shared `walkCascade` primitive so there is exactly one
 * cascade semantics in this repo.
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

  async resolve(tenantId: string, paletteKey: string, departmentId?: string | null): Promise<ResolvedWorkflowAssignment> {
    const tiers: CascadeTier<WorkflowAssignmentSource>[] = [];

    if (departmentId) {
      const departmentRow = await this.assignmentRepository.findForScope(tenantId, PipelinePolicyScope.DEPARTMENT, departmentId, paletteKey);
      tiers.push({ source: 'department', value: departmentRow?.workflowDefinitionSlug ?? null });
    }

    const tenantRow = await this.assignmentRepository.findForScope(tenantId, PipelinePolicyScope.TENANT, null, paletteKey);
    tiers.push({ source: 'tenant', value: tenantRow?.workflowDefinitionSlug ?? null });

    // `null` is the code default: NO tier assigned anything, so the caller
    // keeps its own platform-default resolution. Falling back to it is the
    // declared last tier, not a silent substitution.
    const walked = walkCascade<WorkflowAssignmentSource, string | null>(tiers, null);
    if (walked.value === null) {
      return { workflowDefinitionSlug: null, source: 'platform-default' };
    }

    // An assignment is a REFERENCE, and a reference can rot: the definition it
    // names may have been deprecated or soft-deleted since. Falling back is
    // right; falling back SILENTLY is not.
    const published = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, walked.value);
    if (!published || published.paletteKey !== paletteKey) {
      this.logger.warn({
        message: 'Workflow assignment points at a slug with no ACTIVE PUBLISHED definition — falling back to the platform default',
        tenantId,
        paletteKey,
        departmentId: departmentId ?? null,
        workflowDefinitionSlug: walked.value,
        assignedAt: walked.source,
      });
      return { workflowDefinitionSlug: null, source: 'platform-default' };
    }

    return { workflowDefinitionSlug: walked.value, source: walked.source as WorkflowAssignmentSource };
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
   * (the `PipelinePolicyService.upsertRow` contract).
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

    const changedBy = this.requestUserId ?? null;
    const reason = dto.reason ?? null;
    const existing = await this.assignmentRepository.findForScope(tenantId, scope, scopeId, dto.paletteKey);

    if (existing) {
      const beforeSlug = existing.workflowDefinitionSlug;
      existing.workflowDefinitionSlug = dto.workflowDefinitionSlug;
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
      data: { scope, scopeId, paletteKey: created.paletteKey, workflowDefinitionSlug: created.workflowDefinitionSlug },
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
