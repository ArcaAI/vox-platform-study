import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelEntity,
  AiModelRepository,
  AiRoutingPolicyEntity,
  AiRoutingPolicyFactory,
  AiRoutingPolicyRepository,
  AiRoutingPolicyStatus,
  CoreDatabaseService,
  CoreUnitOfWorkService,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import { IAiTaskDefaultService } from './IAiTaskDefaultService';
import { AiTaskDefaultDtoMapper } from './ai-task-default.dto.mapper';
import {
  AI_TASK_KEYS,
  AI_TASK_KIND_BY_TASK_KEY,
  AI_TASK_MODEL_TASK_TYPES,
  AiTaskKey,
  SUPER_ADMIN_ONLY_TASK_PREFIXES,
  isSuperAdminOnlyTaskKey,
  isGuardrailTaskKey,
} from './constants';
import { AiTaskDefaultResponse, AiTaskModelSummary, EffectiveAiTaskDefaultResponse, UpsertAiTaskDefaultRequest } from './dto';

/**
 * "Default model for task X" — a FACADE over `AiRoutingPolicy`.
 *
 * @deprecated TASK-862 — removed in R3. `AiRoutingPolicy` is the source of
 * truth for "which provider + model serves task X for tenant Y" (owner
 * decision OD-3, 2026-09-01). Since TASK-862 this service touches the
 * `AiTaskDefault` TABLE for NOTHING: reads stand on
 * `AiRoutingPolicyService.resolveDefault`, and `upsertRow` writes ONLY the
 * elected `AiRoutingPolicy` row. The `IAiTaskDefaultService` token, the
 * interface and the DTO shapes are kept so the ~40 remaining readers keep
 * compiling while they are repointed one by one; new code injects
 * `IAiRoutingPolicyService` and calls `resolveDefault` directly.
 *
 * What still holds, because it is governance rather than storage:
 *   - `nlp.*` / `harness.*` keys are SUPER_ADMIN-only to write and resolve
 *     SYSTEM-only at read time (`ForbiddenException`, 403 — a privilege rule on
 *     a key the caller can already read, not the 404-over-403 posture);
 *   - `text.*` and `guardrail.*` are tenant-admin configurable; `guardrail.*`
 *     carries the platform floor (D2, tighten-only): a tenant write must name
 *     a slug on the platform-approved (SYSTEM-tenant `AiModel`) list.
 */
@Injectable()
export class AiTaskDefaultService extends BaseService implements IAiTaskDefaultService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    // r2605 Finding A — the UNSCOPED base client backs the cross-tenant lane
    // (mirrors `HarnessPolicyService`'s injection of the same token).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // The ONLY table this facade writes. The election unset + set run in one
    // transaction, so `unitOfWork` is REQUIRED (see `AiRoutingPolicyService.setDefault`).
    private readonly aiRoutingPolicyRepository: AiRoutingPolicyRepository,
    private readonly unitOfWork: CoreUnitOfWorkService,
    @Inject(IAiRoutingPolicyService) private readonly routingPolicies: IAiRoutingPolicyService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    // Sys-events name the table actually written.
    super(eventEmitter, clsService, ResourceType.AiRoutingPolicy);
  }

  /** @deprecated TASK-862 — call `IAiRoutingPolicyService.resolveDefault` directly. */
  async getEffective(taskKey: string, tenantId?: string): Promise<EffectiveAiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);

    // SUPER_ADMIN-only tasks resolve SYSTEM only (orphan tenant override rows
    // remain harmless but never win at runtime).
    const resolved = await this.routingPolicies.resolveDefault(scopedTenantId, taskKey, { systemOnly: isSuperAdminOnlyTaskKey(taskKey) });

    return {
      tenantId: scopedTenantId,
      taskKey,
      modelSlug: resolved.model?.slug ?? resolved.policy?.modelRef ?? null,
      source: resolved.source,
      configJson: (resolved.policy?.configJson as Record<string, unknown> | null | undefined) ?? null,
      model: resolved.model ? AiTaskDefaultDtoMapper.toModelSummary(resolved.model) : null,
    };
  }

  /**
   * The public projection of {@link resolveEnabledModelBySlug} — a workflow
   * node's `llmBinding.modelSlug` resolves through the same tenant → SYSTEM,
   * ENABLED-only lookup. See the interface for why there is no `taskKey`
   * parameter and why a miss is `null` rather than a throw.
   */
  async resolveModelBySlug(modelSlug: string, tenantId?: string): Promise<AiTaskModelSummary | null> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const model = await this.resolveEnabledModelBySlug(scopedTenantId, modelSlug, tx);
    return model ? AiTaskDefaultDtoMapper.toModelSummary(model) : null;
  }

  /** @deprecated TASK-862 — the "raw row" is the tenant's own elected `AiRoutingPolicy` configuration. */
  async getRow(taskKey: string, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    const elected = await this.findElectedRow(scopedTenantId, taskKey, tx);
    if (!elected) return AiTaskDefaultDtoMapper.placeholder(scopedTenantId, taskKey);
    const model = elected.modelId ? await this.aiModelRepository.findById(elected.modelId).catch(() => null) : null;
    return this.toRowResponse(elected, model?.slug ?? elected.modelRef ?? null);
  }

  /** @deprecated TASK-862 — writes ONLY the elected `AiRoutingPolicy` row; the `AiTaskDefault` table is never touched. */
  async upsertRow(taskKey: string, dto: UpsertAiTaskDefaultRequest, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);

    // GOVERNANCE: nlp / harness model routing is exclusively super-admin-managed
    // (text.* and guardrail.* are tenant-configurable — see the class doc
    // comment). A privilege rule — 403, not 404.
    if (SUPER_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p)) && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`AI task '${taskKey}' is managed by super administrators only.`);
    }

    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    // (D2, tighten-only) — guardrail platform floor: a binding for a non-SYSTEM
    // tenant must name a slug on the platform-approved list (a SYSTEM-tenant
    // AiModel row). Writing the SYSTEM row itself is exempt.
    if (isGuardrailTaskKey(taskKey) && scopedTenantId !== SYSTEM_TENANT_ID) {
      await this.assertGuardrailModelApproved(taskKey, dto.modelSlug, tx);
    }

    // The slug must resolve to an ENABLED AiModel in [tenant, SYSTEM] whose
    // taskType matches the task key's compatibility mapping.
    const model = await this.resolveEnabledModelBySlug(scopedTenantId, dto.modelSlug, tx);
    if (!model) {
      throw new ArgumentInvalidException(`Model slug '${dto.modelSlug}' does not resolve to an ENABLED model in the tenant or platform registry.`);
    }
    const requiredTaskType = AI_TASK_MODEL_TASK_TYPES[taskKey as AiTaskKey];
    if (model.taskType !== requiredTaskType) {
      throw new ArgumentInvalidException(
        `Model '${dto.modelSlug}' has taskType '${model.taskType}' but task '${taskKey}' requires '${requiredTaskType}'.`,
      );
    }

    const elected = await this.findElectedRow(scopedTenantId, taskKey, tx);

    if (!elected) {
      // No elected configuration yet — a create. The client must declare
      // `expectedVersion: 0` (an omitted token is tolerated as a create).
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('AiRoutingPolicy', `${scopedTenantId}:${taskKey}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
        tenantId: scopedTenantId,
        taskKey,
        taskKind: AI_TASK_KIND_BY_TASK_KEY[taskKey as AiTaskKey] ?? null,
        displayName: model.slug,
        modelId: model.id,
        isDefault: true,
        enabled: true,
        configJson: (dto.configJson ?? null) as never,
        // ACTIVE, not DRAFT: a task default serves the moment it is written.
        status: AiRoutingPolicyStatus.ACTIVE,
        activatedAt: new Date(),
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.unitOfWork.runInTransaction(async (trx) => {
        // Free the election slot first, so the partial unique index cannot
        // refuse the insert.
        await this.aiRoutingPolicyRepository.clearDefaultFor(scopedTenantId, taskKey, null, trx, this.requestUserId ?? undefined);
        return this.aiRoutingPolicyRepository.create(entity, trx);
      });
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: { taskKey, modelSlug: model.slug, action: 'task-default-elected' },
      });
      return this.toRowResponse(saved, model.slug);
    }

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    if (dto.expectedVersion === undefined || dto.expectedVersion !== elected.version) {
      throw new OptimisticConcurrencyException('AiRoutingPolicy', elected.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: elected.version,
      });
    }

    const changes: Record<string, unknown> = { modelId: model.id, displayName: model.slug };
    if (dto.configJson !== undefined) changes.configJson = dto.configJson;
    await this.updateEntity(elected, changes);
    // PUT is idempotent (RFC 9110 §9.2.2): re-sending the stored value yields
    // the same representation — no version bump, no event.
    if (!elected.hasChanges) {
      return this.toRowResponse(elected, model.slug);
    }
    const previousVersion = elected.version;
    const updated = await this.unitOfWork.runInTransaction(async (trx) =>
      this.aiRoutingPolicyRepository.updateWithVersion(elected.id, elected, dto.expectedVersion, trx),
    );
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { taskKey, modelSlug: model.slug, previousVersion, newVersion: updated.version, action: 'task-default-updated' },
    });
    return this.toRowResponse(updated, model.slug);
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The tenant's OWN elected configuration for `(tenantId, taskKey)`, in ANY
   * status — this is the row an OCC write CASes against, so a DRAFT or parked
   * default must still be found rather than silently duplicated.
   */
  private async findElectedRow(tenantId: string, taskKey: string, tx?: CoreDatabaseService['baseClient']): Promise<AiRoutingPolicyEntity | null> {
    const rows = await this.aiRoutingPolicyRepository.findCandidates([tenantId], taskKey, tx, { activeOnly: false, enabledOnly: false });
    return rows.find((row) => row.isDefault) ?? null;
  }

  /** The legacy row shape, projected from the elected `AiRoutingPolicy` configuration. */
  private toRowResponse(policy: AiRoutingPolicyEntity, modelSlug: string | null): AiTaskDefaultResponse {
    return {
      tenantId: policy.tenantId,
      taskKey: policy.taskKey,
      modelSlug,
      configJson: (policy.configJson as Record<string, unknown> | null | undefined) ?? null,
      resourceStatus: policy.resourceStatus ?? undefined,
      version: policy.version,
      createdAt: policy.createdAt?.toISOString(),
      updatedAt: policy.updatedAt?.toISOString(),
    };
  }

  /**
   * r2605 Finding A — the cross-tenant persistence lane. When the resolved
   * target differs from the CLS tenant (or CLS carries no tenant) AND the
   * caller is a super admin, route the read/write set through the UNSCOPED
   * base client so the queries carry ONLY the explicit tenant filters.
   */
  private crossTenantLane(targetTenantId: string): CoreDatabaseService['baseClient'] | undefined {
    if (targetTenantId !== this.tenantId && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }

  private assertKnownTaskKey(taskKey: string): void {
    if (!(AI_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new ArgumentInvalidException(`Unknown AI task key '${taskKey}'. Expected one of: ${AI_TASK_KEYS.join(', ')}`);
    }
  }

  /** Explicit tenant target (super-admin `?tenantId=`) over the CLS tenant. */
  private resolveScopedTenantId(tenantId?: string): string {
    const scoped = tenantId ?? this.tenantId;
    if (!scoped) {
      throw new BadRequestException('Tenant ID is required');
    }
    return scoped;
  }

  /**
   * (D2) — the guardrail platform floor. Throws `ForbiddenException` unless
   * `slug` resolves to an ENABLED, SYSTEM-tenant `AiModel` row.
   */
  private async assertGuardrailModelApproved(taskKey: string, slug: string, tx?: CoreDatabaseService['baseClient']): Promise<void> {
    const approved = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug, tx);
    if (!approved) {
      throw new ForbiddenException(
        `Model slug '${slug}' is not on the platform-approved list for '${taskKey}'. Guardrail model selection is limited to models registered in the platform (SYSTEM) catalog.`,
      );
    }
  }

  /** Resolve a slug to an ENABLED AiModel in [tenant, SYSTEM], preferring the tenant-owned row. */
  private async resolveEnabledModelBySlug(tenantId: string, slug: string, tx?: CoreDatabaseService['baseClient']): Promise<AiModelEntity | null> {
    if (tenantId !== SYSTEM_TENANT_ID) {
      const own = await this.aiModelRepository.findBySlug(tenantId, slug, tx);
      if (own) return own;
    }
    return this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug, tx);
  }
}
