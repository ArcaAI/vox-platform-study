import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelEntity,
  AiModelRepository,
  AiTaskDefaultFactory,
  AiTaskDefaultRepository,
  CoreDatabaseService,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAiTaskDefaultService } from './IAiTaskDefaultService';
import { AiTaskDefaultDtoMapper } from './ai-task-default.dto.mapper';
import {
  AI_TASK_KEYS,
  AI_TASK_MODEL_TASK_TYPES,
  AiTaskKey,
  SUPER_ADMIN_ONLY_TASK_PREFIXES,
  isSuperAdminOnlyTaskKey,
  isGuardrailTaskKey,
} from './constants';
import { AiTaskDefaultResponse, AiTaskModelSummary, EffectiveAiTaskDefaultResponse, UpsertAiTaskDefaultRequest } from './dto';

/**
 * "Default model for task X" service.
 *
 * Effective resolution for SUPER_ADMIN-only keys (`nlp.*`, `harness.*`) is
 * SYSTEM-row-only (tenant override rows are ignored at read time). Writes to
 * those prefixes require SUPER_ADMIN → `ForbiddenException` (403). This is
 * deliberately NOT the 404-over-403 tenancy posture: the rule is a privilege
 * boundary on a key the caller can already read, not a cross-tenant existence
 * probe.
 *
 * `text.*` and, as of TASK-735 Phase 0 (owner decision 2026-08-16),
 * `guardrail.*` are tenant-admin configurable: those keys honour per-tenant
 * override rows at read time and accept tenant writes. `guardrail.*` carries
 * an ADDITIONAL platform floor on top of that (D2, tighten-only): a write
 * targeting a non-SYSTEM tenant must resolve `modelSlug` to a SYSTEM-tenant
 * `AiModel` row (the platform-approved list) — see `assertGuardrailModelApproved`.
 * A `featureGuardrailModelSelection` entitlement ceiling is catalogued
 * (`settings-registry/descriptors/entitlements.descriptors.ts`) but NOT yet
 * enforced here — it needs a `PlanEntitlement`/`TenantEntitlement` DB column
 * outside this ticket's file scope (see the TASK-735 ticket README §7).
 */
@Injectable()
export class AiTaskDefaultService extends BaseService implements IAiTaskDefaultService {
  constructor(
    private readonly aiTaskDefaultRepository: AiTaskDefaultRepository,
    private readonly aiModelRepository: AiModelRepository,
    // r2605 Finding A — the UNSCOPED base client backs the cross-tenant lane
    // (mirrors `HarnessPolicyService`'s injection of the same token).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiTaskDefault);
  }

  async getEffective(taskKey: string, tenantId?: string): Promise<EffectiveAiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    // SUPER_ADMIN-only tasks resolve SYSTEM only (orphan tenant
    // override rows remain harmless but never win at runtime).
    const systemOnly = isSuperAdminOnlyTaskKey(taskKey);

    const [tenantRow, systemRow] = await Promise.all([
      systemOnly || scopedTenantId === SYSTEM_TENANT_ID
        ? Promise.resolve(null)
        : this.aiTaskDefaultRepository.findByTenantAndTaskKey(scopedTenantId, taskKey, tx),
      this.aiTaskDefaultRepository.findByTenantAndTaskKey(SYSTEM_TENANT_ID, taskKey, tx),
    ]);

    const winning = tenantRow ?? systemRow ?? null;
    const source: 'tenant' | 'system' | null = tenantRow ? 'tenant' : systemRow ? 'system' : null;
    const model = winning ? await this.resolveEnabledModelBySlug(scopedTenantId, winning.modelSlug, tx) : null;

    return {
      tenantId: scopedTenantId,
      taskKey,
      modelSlug: winning?.modelSlug ?? null,
      source,
      configJson: winning?.configJson ?? null,
      model: model ? AiTaskDefaultDtoMapper.toModelSummary(model) : null,
    };
  }

  /**
   * TASK-816 (DD-10) — the public projection of {@link resolveEnabledModelBySlug}.
   *
   * A workflow node's `llmBinding.modelSlug` is the same KIND of reference an
   * `AiTaskDefault` row's `modelSlug` is, so it resolves through the same
   * method: tenant-owned ENABLED row first, SYSTEM row otherwise, on the same
   * cross-tenant read lane. See the interface for why there is no `taskKey`
   * parameter and why a miss is `null` rather than a throw.
   */
  async resolveModelBySlug(modelSlug: string, tenantId?: string): Promise<AiTaskModelSummary | null> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const model = await this.resolveEnabledModelBySlug(scopedTenantId, modelSlug, tx);
    return model ? AiTaskDefaultDtoMapper.toModelSummary(model) : null;
  }

  async getRow(taskKey: string, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    const row = await this.aiTaskDefaultRepository.findByTenantAndTaskKey(scopedTenantId, taskKey, tx);
    return row ? AiTaskDefaultDtoMapper.toResponse(row) : AiTaskDefaultDtoMapper.placeholder(scopedTenantId, taskKey);
  }

  async upsertRow(taskKey: string, dto: UpsertAiTaskDefaultRequest, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);

    // GOVERNANCE: nlp / harness model routing is exclusively super-admin-managed
    // (text.* and, since TASK-735, guardrail.* are tenant-configurable — see the
    // class doc comment). A privilege rule — 403, not 404 (the caller can
    // already READ these keys; only writes are gated).
    if (SUPER_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p)) && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`AI task '${taskKey}' is managed by super administrators only.`);
    }

    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    // TASK-735 Phase 0 (D2, tighten-only) — guardrail platform floor: a
    // binding for a non-SYSTEM tenant must name a slug on the platform-
    // approved list (a SYSTEM-tenant AiModel row), regardless of whether the
    // caller also holds a tenant-owned model of the same slug. Writing the
    // SYSTEM row itself (super-admin defining the approved list) is exempt.
    // This is a 403 privilege boundary — not the 404-over-403 tenancy posture
    // and not a silent clamp to some other slug.
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

    const existing = await this.aiTaskDefaultRepository.findByTenantAndTaskKey(scopedTenantId, taskKey, tx);

    if (!existing) {
      // No row yet — a create. The client must declare `expectedVersion: 0`
      // (an omitted token is tolerated as a create).
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('AiTaskDefault', `${scopedTenantId}:${taskKey}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = AiTaskDefaultFactory.CreateAiTaskDefault({
        tenantId: scopedTenantId,
        taskKey,
        modelSlug: dto.modelSlug,
        configJson: dto.configJson ?? null,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.aiTaskDefaultRepository.create(entity, tx);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: { taskKey, modelSlug: saved.modelSlug },
      });
      return AiTaskDefaultDtoMapper.toResponse(saved);
    }

    const changes: Record<string, unknown> = { modelSlug: dto.modelSlug };
    if (dto.configJson !== undefined) {
      changes.configJson = dto.configJson;
    }
    await this.updateEntity(existing, changes);
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(existing, dto.expectedVersion);
    if (dto.expectedVersion === undefined) {
      // A CAS update without a token cannot be verified — surface it as a
      // concurrency error (the gateway's @RequiresIfMatch 428s before this).
      throw new OptimisticConcurrencyException('AiTaskDefault', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }
    // PUT is idempotent by contract (RFC 9110 §9.2.2): re-sending a value that is
    // already stored must yield the SAME observable result as the first send, not a
    // 400. Returning the current representation satisfies BOTH that and the
    // phantom-write rule — no version bump, no `updatedAt` rewrite, no
    // ResourceUpdated event. (PATCH routes keep throwing `ArgumentInvalidException`;
    // there "you sent me nothing to change" IS the documented answer.)
    // The OCC precondition above has already run, so a STALE token still gets 412
    // rather than a misleading 200.
    if (!existing.hasChanges) {
      return AiTaskDefaultDtoMapper.toResponse(existing);
    }
    const previousVersion = existing.version;
    const updated = await this.aiTaskDefaultRepository.updateWithVersion(existing.id, existing, dto.expectedVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { taskKey, modelSlug: updated.modelSlug, previousVersion, newVersion: updated.version },
    });
    return AiTaskDefaultDtoMapper.toResponse(updated);
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * r2605 Finding A — the cross-tenant persistence lane.
   *
   * A super admin's working tenant W is elevated into CLS by the BFF proxy
   * on every request, so when the platform screen targets `?tenantId=SYSTEM`
   * (or any foreign tenant) through the EXTENDED client, the tenant-scope
   * extension injects W everywhere: the CAS `updateMany` matches 0 rows
   * (eternal 412 despite a correct If-Match), the create throws
   * `TenantScope: tenantId mismatch` (500), and reads miss. When the resolved
   * target differs from the CLS tenant (or CLS carries no tenant) AND the
   * caller is a super admin, route the whole read/write set through the
   * UNSCOPED base client so the queries carry ONLY the explicit tenant
   * filters (mirrors `HarnessPolicyService.upsert`'s baseClient usage).
   * Tenant admins are pinned to their CLS tenant by `resolveScopedTenantId`
   * upstream, so they can never reach this lane — their path is unchanged.
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
   * TASK-735 Phase 0 (D2) — the guardrail platform floor. Throws
   * `ForbiddenException` unless `slug` resolves to an ENABLED, SYSTEM-tenant
   * `AiModel` row. Deliberately independent of `resolveEnabledModelBySlug`:
   * that method also accepts a TENANT-owned row for the same slug, which
   * would let a tenant register their own unvetted model under a guardrail
   * task key — exactly what the platform-approved-list floor exists to stop.
   */
  private async assertGuardrailModelApproved(taskKey: string, slug: string, tx?: CoreDatabaseService['baseClient']): Promise<void> {
    const approved = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug, tx);
    if (!approved) {
      throw new ForbiddenException(
        `Model slug '${slug}' is not on the platform-approved list for '${taskKey}'. Guardrail model selection is limited to models registered in the platform (SYSTEM) catalog.`,
      );
    }
  }

  /**
   * Resolve a slug to an ENABLED AiModel in [tenant, SYSTEM], preferring the
   * tenant-owned row (`findBySlug` pins exact-tenant + ENABLED). `tx` threads
   * the cross-tenant base-client lane through the model reads too — without
   * it, a super admin acting under working tenant W would have the foreign
   * tenant's row read rewritten/rejected by the tenant-scope extension.
   */
  private async resolveEnabledModelBySlug(tenantId: string, slug: string, tx?: CoreDatabaseService['baseClient']): Promise<AiModelEntity | null> {
    if (tenantId !== SYSTEM_TENANT_ID) {
      const own = await this.aiModelRepository.findBySlug(tenantId, slug, tx);
      if (own) return own;
    }
    return this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug, tx);
  }
}
