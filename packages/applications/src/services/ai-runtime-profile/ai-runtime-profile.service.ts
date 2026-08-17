import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiRuntimeProfileEntity,
  AiRuntimeProfileFactory,
  AiRuntimeProfileRepository,
  CoreDatabaseService,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAiRuntimeProfileService, ResolvedRuntimeProfile } from './IAiRuntimeProfileService';
import { AiRuntimeProfileDtoMapper } from './ai-runtime-profile.dto.mapper';
import { AiRuntimeProfileResponse, UpsertAiRuntimeProfileRequest } from './dto';

/** The provider-level default sentinel. NOT null — see the entity/schema headers. */
const PROVIDER_DEFAULT_SLUG = '';

/**
 * Numeric guardrails, duplicated from the DTO decorators so a
 * service-to-service caller that bypasses the global validation pipe still
 * cannot persist an out-of-range value. `null` is always permitted — it means
 * "no opinion", not zero.
 */
const RANGES: Record<string, { min: number; max?: number }> = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxTokens: { min: 0 },
  contextLength: { min: 0 },
  maxConcurrent: { min: 0 },
  tpmLimit: { min: 0 },
  rpmLimit: { min: 0 },
  timeoutS: { min: 0 },
  keepAliveSeconds: { min: 0 },
};

/** The knob fields, in cascade-merge order. */
const KNOBS = ['temperature', 'topP', 'maxTokens', 'contextLength', 'maxConcurrent', 'tpmLimit', 'rpmLimit', 'timeoutS', 'keepAliveSeconds'] as const;

/**
 * Runtime-profile service.
 *
 * Hyperparameters / context / concurrency are SUPER_ADMIN-ONLY and
 * SYSTEM-tenant-only by design. A write from a
 * non-super-admin, or targeting any tenant other than SYSTEM, is a PRIVILEGE
 * boundary → 403 (not the 404-over-403 cross-tenant posture).
 *
 * The resolution contract is deliberately forgiving: a missing profile is NOT
 * an error, it resolves to all-null / `isEmpty: true`. That is what lets the
 * gateway inject nothing and leave forwarded requests byte-identical while
 * zero profile rows are seeded (a silent-change guard).
 */
@Injectable()
export class AiRuntimeProfileService extends BaseService implements IAiRuntimeProfileService {
  constructor(
    private readonly profileRepository: AiRuntimeProfileRepository,
    // The UNSCOPED base client backing the cross-tenant lane — profiles live on
    // the SYSTEM tenant while a super admin acts under a working tenant.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiRuntimeProfile);
  }

  async list(): Promise<AiRuntimeProfileResponse[]> {
    const tx = this.crossTenantLane();
    const rows = await this.profileRepository.findByTenantId(SYSTEM_TENANT_ID, tx);
    return rows.map((r) => AiRuntimeProfileDtoMapper.toResponse(r));
  }

  async getProfile(provider: string, modelSlug: string): Promise<AiRuntimeProfileResponse> {
    const tx = this.crossTenantLane();
    const row = await this.profileRepository.findByTenantProviderAndModel(SYSTEM_TENANT_ID, provider, modelSlug, tx);
    return row ? AiRuntimeProfileDtoMapper.toResponse(row) : AiRuntimeProfileDtoMapper.placeholder(SYSTEM_TENANT_ID, provider, modelSlug);
  }

  async upsertProfile(provider: string, modelSlug: string, dto: UpsertAiRuntimeProfileRequest, tenantId?: string): Promise<AiRuntimeProfileResponse> {
    this.assertWriteAllowed(tenantId);
    this.assertWithinRanges(dto);

    const tx = this.crossTenantLane();
    const existing = await this.profileRepository.findByTenantProviderAndModel(SYSTEM_TENANT_ID, provider, modelSlug, tx);

    if (!existing) {
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('AiRuntimeProfile', `${provider}:${modelSlug}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = AiRuntimeProfileFactory.CreateAiRuntimeProfile({
        tenantId: SYSTEM_TENANT_ID,
        provider,
        modelSlug,
        temperature: dto.temperature ?? null,
        topP: dto.topP ?? null,
        maxTokens: dto.maxTokens ?? null,
        contextLength: dto.contextLength ?? null,
        maxConcurrent: dto.maxConcurrent ?? null,
        tpmLimit: dto.tpmLimit ?? null,
        rpmLimit: dto.rpmLimit ?? null,
        timeoutS: dto.timeoutS ?? null,
        keepAliveSeconds: dto.keepAliveSeconds ?? null,
        extraJson: dto.extraJson ?? null,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.profileRepository.create(entity, tx);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: { provider, modelSlug, action: 'profile-created' },
      });
      return AiRuntimeProfileDtoMapper.toResponse(saved);
    }

    // Only fields the caller actually sent are changed — omitting a knob leaves
    // it as-is, while sending an explicit null clears it to "no opinion".
    const changes: Record<string, unknown> = {};
    for (const knob of KNOBS) {
      if (dto[knob] !== undefined) changes[knob] = dto[knob];
    }
    if (dto.extraJson !== undefined) changes.extraJson = dto.extraJson;

    await this.updateEntity(existing, changes);
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }
    if (dto.expectedVersion === undefined) {
      throw new OptimisticConcurrencyException('AiRuntimeProfile', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }

    const previousVersion = existing.version;
    const updated = await this.profileRepository.updateWithVersion(existing.id, existing, dto.expectedVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { provider, modelSlug, previousVersion, newVersion: updated.version, action: 'profile-updated' },
    });
    return AiRuntimeProfileDtoMapper.toResponse(updated);
  }

  async deleteProfile(provider: string, modelSlug: string, tenantId?: string): Promise<void> {
    this.assertWriteAllowed(tenantId);

    const tx = this.crossTenantLane();
    const existing = await this.profileRepository.findByTenantProviderAndModel(SYSTEM_TENANT_ID, provider, modelSlug, tx);
    if (!existing) {
      throw new ArgumentInvalidException(`No runtime profile for provider '${provider}', model '${modelSlug}'.`);
    }

    // `softDelete(id, updatedBy)` takes no tx client — see the sibling note in
    // AiProviderConnectionService.deleteRow.
    await this.profileRepository.softDelete(existing.id, this.requestUserId ?? undefined);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: existing.id,
      data: { provider, modelSlug, action: 'profile-deleted' },
    });
  }

  async resolveProfile(provider: string, modelSlug: string): Promise<ResolvedRuntimeProfile> {
    const tx = this.crossTenantLane();

    const [modelRow, defaultRow] = await Promise.all([
      modelSlug && modelSlug !== PROVIDER_DEFAULT_SLUG
        ? this.profileRepository.findByTenantProviderAndModel(SYSTEM_TENANT_ID, provider, modelSlug, tx)
        : Promise.resolve(null),
      this.profileRepository.findByTenantProviderAndModel(SYSTEM_TENANT_ID, provider, PROVIDER_DEFAULT_SLUG, tx),
    ]);

    const resolved: ResolvedRuntimeProfile = {
      provider,
      modelSlug,
      temperature: null,
      topP: null,
      maxTokens: null,
      contextLength: null,
      maxConcurrent: null,
      tpmLimit: null,
      rpmLimit: null,
      timeoutS: null,
      keepAliveSeconds: null,
      extraJson: null,
      isEmpty: true,
    };

    // PER-FIELD merge: the model row wins only for fields it actually sets.
    // A null on the model row is "no opinion" and must fall through to the
    // provider default — not clobber it.
    let anyOpinion = false;
    for (const knob of KNOBS) {
      const value = this.pick(modelRow, defaultRow, knob);
      if (value !== null) {
        (resolved as unknown as Record<string, unknown>)[knob] = value;
        anyOpinion = true;
      }
    }

    const extra = (modelRow?.extraJson ?? defaultRow?.extraJson ?? null) as Record<string, unknown> | null;
    if (extra) {
      resolved.extraJson = extra;
      anyOpinion = true;
    }

    resolved.isEmpty = !anyOpinion;
    return resolved;
  }

  // ────────────────────────────── internals ──────────────────────────────

  private pick(modelRow: AiRuntimeProfileEntity | null, defaultRow: AiRuntimeProfileEntity | null, knob: (typeof KNOBS)[number]): number | null {
    const fromModel = modelRow?.[knob] ?? null;
    if (fromModel !== null) return fromModel;
    return defaultRow?.[knob] ?? null;
  }

  /**
   * Hyperparameters are super-admin-only AND SYSTEM-tenant-only (E5). Both
   * violations are 403 — the caller is being told "you may not", not "this
   * does not exist".
   */
  private assertWriteAllowed(tenantId?: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('AI runtime profiles are managed by super administrators only.');
    }
    if (tenantId !== undefined && tenantId !== SYSTEM_TENANT_ID) {
      throw new ForbiddenException('AI runtime profiles are platform-level configuration and exist only on the SYSTEM tenant.');
    }
  }

  private assertWithinRanges(dto: UpsertAiRuntimeProfileRequest): void {
    for (const [field, range] of Object.entries(RANGES)) {
      const value = (dto as Record<string, unknown>)[field];
      // undefined = not sent; null = explicitly "no opinion". Both are fine.
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ArgumentInvalidException(`Setting '${field}' must be a number.`);
      }
      if (value < range.min || (range.max !== undefined && value > range.max)) {
        const bound = range.max !== undefined ? `${range.min}–${range.max}` : `>= ${range.min}`;
        throw new ArgumentInvalidException(`Setting '${field}' must be within ${bound} (got ${value}).`);
      }
    }
  }

  /**
   * Profiles always live on the SYSTEM tenant, so whenever the caller's CLS
   * tenant is anything else the reads/writes must go through the UNSCOPED base
   * client — otherwise the tenant-scope extension rewrites `tenantId` to the
   * admin's working tenant and every query silently misses.
   */
  private crossTenantLane(): CoreDatabaseService['baseClient'] | undefined {
    if (SYSTEM_TENANT_ID !== this.tenantId && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }
}
