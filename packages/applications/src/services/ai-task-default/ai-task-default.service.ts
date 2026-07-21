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
  GLOBAL_ADMIN_ONLY_TASK_PREFIXES,
  isGlobalAdminOnlyTaskKey,
} from './constants';
import { AiTaskDefaultResponse, EffectiveAiTaskDefaultResponse, UpsertAiTaskDefaultRequest } from './dto';

/**
 * "Default model for task X" service.
 *
 * Effective resolution for GLOBAL_ADMIN-only keys (`guardrail.*`, `smr.*`,
 * `nlp.*`) is SYSTEM-row-only (tenant override rows are ignored at read time).
 * Writes to those prefixes require GLOBAL_ADMIN → `ForbiddenException` (403).
 * This is deliberately NOT the 404-over-403 tenancy posture: the rule is a
 * privilege boundary on a key the caller can already read, not a cross-tenant
 * existence probe.
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

    // GLOBAL_ADMIN-only tasks resolve SYSTEM only (orphan tenant
    // override rows remain harmless but never win at runtime).
    const systemOnly = isGlobalAdminOnlyTaskKey(taskKey);

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

  async getRow(taskKey: string, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

    const row = await this.aiTaskDefaultRepository.findByTenantAndTaskKey(scopedTenantId, taskKey, tx);
    return row ? AiTaskDefaultDtoMapper.toResponse(row) : AiTaskDefaultDtoMapper.placeholder(scopedTenantId, taskKey);
  }

  async upsertRow(taskKey: string, dto: UpsertAiTaskDefaultRequest, tenantId?: string): Promise<AiTaskDefaultResponse> {
    this.assertKnownTaskKey(taskKey);

    // GOVERNANCE: guardrail and SMR model routing are exclusively
    // global-admin-managed. A privilege rule — 403,
    // not 404 (the caller can already READ these keys; only writes are gated).
    if (GLOBAL_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p)) && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`AI task '${taskKey}' is managed by global administrators only.`);
    }

    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);

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
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }
    if (dto.expectedVersion === undefined) {
      // A CAS update without a token cannot be verified — surface it as a
      // concurrency error (the gateway's @RequiresIfMatch 428s before this).
      throw new OptimisticConcurrencyException('AiTaskDefault', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
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
   * A global admin's working tenant W is elevated into CLS by the BFF proxy
   * on every request, so when the platform screen targets `?tenantId=SYSTEM`
   * (or any foreign tenant) through the EXTENDED client, the tenant-scope
   * extension injects W everywhere: the CAS `updateMany` matches 0 rows
   * (eternal 412 despite a correct If-Match), the create throws
   * `TenantScope: tenantId mismatch` (500), and reads miss. When the resolved
   * target differs from the CLS tenant (or CLS carries no tenant) AND the
   * caller is a global admin, route the whole read/write set through the
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

  /** Explicit tenant target (global-admin `?tenantId=`) over the CLS tenant. */
  private resolveScopedTenantId(tenantId?: string): string {
    const scoped = tenantId ?? this.tenantId;
    if (!scoped) {
      throw new BadRequestException('Tenant ID is required');
    }
    return scoped;
  }

  /**
   * Resolve a slug to an ENABLED AiModel in [tenant, SYSTEM], preferring the
   * tenant-owned row (`findBySlug` pins exact-tenant + ENABLED). `tx` threads
   * the cross-tenant base-client lane through the model reads too — without
   * it, a global admin acting under working tenant W would have the foreign
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
