import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantAllowedOriginEntity,
  TenantAllowedOriginFactory,
  TenantAllowedOriginRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { normalizeOrigin } from '../origin-registry/origin-normalizer';
import { ALLOW_ALL_ORIGIN_PATTERN, isOriginPattern, normalizeOriginPattern } from '../origin-registry/origin-pattern';
import { ITenantAllowedOriginService } from './ITenantAllowedOriginService';
import { CreateTenantAllowedOriginRequest, TenantAllowedOriginResponse, UpdateTenantAllowedOriginRequest } from './dto';
import { TenantAllowedOriginDtoMapper } from './tenant-allowed-origin.dto.mapper';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

/**
 * The frozen invalidation contract (README §4.1). Every successful mutation
 * emits this so `OriginRegistryService` (W2-A) rebuilds its
 * `Map<origin, ownerTenantId>` on the writing node immediately, rather than
 * waiting for the 45s `AppSettingsService` cron backstop.
 */
const ORIGIN_REGISTRY_INVALIDATE_EVENT = 'origin-registry.invalidate';

/** Structurally identifies a Prisma unique-constraint violation (P2002) without importing `@prisma/client` runtime code. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<string, unknown>).code === 'P2002';
}

/**
 * Routes an incoming raw origin string to the correct validator BY SHAPE
 * (TASK-610 §4A.2/§4A.3, lane W5-E): `isOriginPattern` is true for anything
 * containing `*` — a wildcard pattern OR the bare allow-all token — which goes
 * through `normalizeOriginPattern`; everything else goes through the
 * pre-existing `normalizeOrigin`. Both throw the SAME `ArgumentInvalidException`
 * on a malformed value, so a caller never has to branch on error type and an
 * invalid pattern surfaces as the same clean validation error an invalid exact
 * origin does. The canonical result — never the raw input — is what gets
 * checked for uniqueness and persisted.
 */
function normalizeIncomingOrigin(raw: string): string {
  return isOriginPattern(raw) ? normalizeOriginPattern(raw) : normalizeOrigin(raw).origin;
}

@Injectable()
export class TenantAllowedOriginService extends BaseService implements ITenantAllowedOriginService {
  private readonly logger = new Logger(TenantAllowedOriginService.name);

  constructor(
    private readonly tenantAllowedOriginRepository: TenantAllowedOriginRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantAllowedOrigin);
  }

  async getAll(): Promise<TenantAllowedOriginResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const rows = await this.tenantAllowedOriginRepository.findAll({ where: { tenantId } });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: rows.length },
    });

    return rows.map(TenantAllowedOriginDtoMapper.toResponse);
  }

  async getById(id: string): Promise<TenantAllowedOriginResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const entity = await this.findOwnedOrThrow(id, tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: entity.id,
    });

    return TenantAllowedOriginDtoMapper.toResponse(entity);
  }

  async create(dto: CreateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Origin SYNTAX is decided exclusively by `normalizeOrigin` / `normalizeOriginPattern`,
    // routed by shape (README §4A.2/§4A.3) — the NORMALIZED form, never the raw
    // input, is what gets checked and persisted. Both throw the same
    // `ArgumentInvalidException` on anything malformed.
    const normalizedOrigin = normalizeIncomingOrigin(dto.origin);

    // §4B — a row IS a (origin, tenant) GRANT, not an owned origin. A LIVE
    // grant for THIS tenant on this origin is a genuine duplicate — reject
    // it up front. A grant some OTHER tenant already holds on the same
    // origin is NOT a conflict: two tenants sharing an origin is the point
    // of the many-to-many model, so `findByOriginAndTenant` only ever looks
    // at rows scoped to `tenantId` and simply cannot see (let alone block
    // on) another tenant's grant.
    const liveExisting = await this.tenantAllowedOriginRepository.findByOriginAndTenant(normalizedOrigin, tenantId);
    if (liveExisting) {
      throw new ConflictException(`Origin '${normalizedOrigin}' is already registered for this tenant.`);
    }

    // The unique index is now on (origin, tenantId) and is NOT partial (see
    // the schema comment on `TenantAllowedOrigin_origin_tenantId_unique`), so
    // a soft-deleted grant for THIS tenant still occupies that pair —
    // `findByOriginAndTenant` only sees ENABLED rows and cannot see it. A
    // delete -> re-add BY THE SAME TENANT must RESTORE that row, never
    // insert a second one, and never refuse with a "conflict" the admin list
    // cannot explain (the origin appears nowhere in THIS tenant's list, yet
    // create says it's taken). A soft-deleted grant belonging to a
    // DIFFERENT tenant must NOT surface here at all — tenant B creating the
    // same origin is a brand-new, different grant and must succeed as an
    // ordinary create, not a restore of tenant A's row.
    const deletedExisting = await this.findDeletedByOriginAndTenant(normalizedOrigin, tenantId);
    if (deletedExisting) {
      return this.restoreOnCreateCollision(deletedExisting, dto, tenantId);
    }

    const entity = TenantAllowedOriginFactory.CreateTenantAllowedOrigin({
      tenantId,
      origin: normalizedOrigin,
      label: dto.label,
      description: dto.description,
      createdBy: this.requestUserId ?? undefined,
    });

    let saved: TenantAllowedOriginEntity;
    try {
      saved = await this.tenantAllowedOriginRepository.create(entity);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Check-then-write race: the (origin, tenantId) row transitioned
        // between our checks and this write. Retry the soft-deleted lookup
        // once — a concurrent delete BY THIS TENANT could have landed in
        // that exact window — before concluding THIS TENANT already has a
        // live grant on this origin. The violated constraint is scoped to
        // (origin, tenantId), so a P2002 here can only mean "this tenant
        // already has this origin" — never "someone has this origin".
        const raced = await this.findDeletedByOriginAndTenant(normalizedOrigin, tenantId);
        if (raced) {
          return this.restoreOnCreateCollision(raced, dto, tenantId);
        }
        throw new ConflictException(`Origin '${normalizedOrigin}' is already registered for this tenant.`);
      }
      throw err;
    }

    this.warnIfAllowAllOrigin(saved.origin, saved.tenantId, 'created');

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { origin: saved.origin, label: saved.label },
    });

    this.emitOriginRegistryInvalidate();

    return TenantAllowedOriginDtoMapper.toResponse(saved);
  }

  /**
   * Reinstate a soft-deleted GRANT that occupies the requested (origin,
   * tenantId) pair, rather than inserting a second row the compound unique
   * index would reject. Treated as a successful CREATE from the caller's
   * perspective: the reinstated row carries the NEW `label`/`description`
   * from this request, not whatever was there before the delete (a delete ->
   * re-add is a fresh registration, not a resurrection of stale metadata —
   * `description` uses `?? null`, not `undefined`, so an omitted note
   * actually clears the old one instead of being skipped by
   * `applyChangesToEntity`'s undefined-is-noop rule).
   *
   * Mirrors the `GlobalSettingService.create` revive-on-create precedent
   * (restore → apply fields → non-versioned `update` only if changed).
   *
   * DEFENSE-IN-DEPTH — cross-tenant ownership check (post-review follow-up,
   * carried forward into the many-to-many model, §4B). Under the OLD
   * single-owner model this guarded against reviving THE ONE row an origin
   * could ever have — reachable only if a read widened past the caller's own
   * tenant. Under §4B there is no longer a single row to steal; the risk is
   * narrower but not eliminated: `deletedEntity` comes from
   * `findDeletedByOriginAndTenant(origin, tenantId)`, which now filters on
   * `tenantId` EXPLICITLY as a query parameter (not merely inferred), and is
   * additionally narrowed by the tenant-scope Prisma extension
   * (`TenantAllowedOrigin` is in `TENANT_SCOPED_MODELS`). Two independent
   * layers already make `deletedEntity.tenantId !== callerTenantId`
   * unreachable with `true` today. It stays here so that guarantee survives
   * either layer breaking on its own — e.g. a future repository refactor
   * that drops the explicit `tenantId` from the `where` clause because "the
   * CLS extension already scopes it", or this model being added to
   * `SYSTEM_SHARED_READ_MODELS` so tenant admins can see platform grants —
   * either of which would otherwise let a tenant be silently credited with
   * reviving (and inheriting the version lineage of) a grant row it does not
   * own. DO NOT remove this as "dead code" — it is deliberately redundant
   * with two other layers, not accidentally so.
   *
   * On a mismatch this is treated EXACTLY like a live duplicate for THIS
   * tenant: same conflict, same message — never a restore, never a
   * different error shape that would hint at another tenant's row.
   */
  private async restoreOnCreateCollision(
    deletedEntity: TenantAllowedOriginEntity,
    dto: CreateTenantAllowedOriginRequest,
    callerTenantId: string,
  ): Promise<TenantAllowedOriginResponse> {
    if (deletedEntity.tenantId !== callerTenantId) {
      throw new ConflictException(`Origin '${deletedEntity.origin}' is already registered for this tenant.`);
    }

    const restored = await this.tenantAllowedOriginRepository.restore(deletedEntity.id, this.requestUserId ?? undefined);

    await this.updateEntity(restored, {
      label: dto.label,
      description: dto.description ?? null,
    });

    const saved = restored.hasChanges ? await this.tenantAllowedOriginRepository.update(restored.id, restored) : restored;

    this.warnIfAllowAllOrigin(saved.origin, saved.tenantId, 'restored');

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { origin: saved.origin, label: saved.label, revivedFromDeleted: true },
    });

    this.emitOriginRegistryInvalidate();

    return TenantAllowedOriginDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const entity = await this.findOwnedOrThrow(id, tenantId);

    const { expectedVersion, origin, ...rest } = dto;

    // Snapshot BEFORE `updateEntity` mutates `entity.origin` in place —
    // needed below to tell "this update just MADE the row `*`" apart from
    // "the row was already `*` and only some other field changed".
    const originBeforeUpdate = entity.origin;

    // Re-normalize `origin` when the DTO changes it (README §3.3 "Re-normalize
    // origin if the DTO changes it"), routed by shape same as `create()`
    // (§4A.2/§4A.3). Skip the duplicate check entirely when the normalized
    // value is identical to the row's current value — that is not a
    // collision with ANOTHER row, just a no-op/idempotent re-submit.
    // §4B: the collision check is scoped to THIS tenant only — another
    // tenant already holding a grant on the same origin is not a conflict.
    let normalizedOrigin: string | undefined;
    if (origin !== undefined) {
      normalizedOrigin = normalizeIncomingOrigin(origin);
      if (normalizedOrigin !== originBeforeUpdate) {
        const existing = await this.tenantAllowedOriginRepository.findByOriginAndTenant(normalizedOrigin, tenantId);
        if (existing && existing.id !== id) {
          throw new ConflictException(`Origin '${normalizedOrigin}' is already registered for this tenant.`);
        }
      }
    }

    await this.updateEntity(entity, {
      ...rest,
      ...(normalizedOrigin !== undefined ? { origin: normalizedOrigin } : {}),
    });

    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    // Snapshot pre-write version BEFORE the CAS bumps it.
    const previousVersion = entity.version;

    let updated: TenantAllowedOriginEntity;
    try {
      updated = await this.tenantAllowedOriginRepository.updateWithVersion(id, entity, expectedVersion);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // The violated constraint is (origin, tenantId) — this can only mean
        // THIS tenant already has this origin on another row.
        throw new ConflictException(`Origin '${normalizedOrigin}' is already registered for this tenant.`);
      }
      throw err;
    }

    // Only when THIS update is what establishes the allow-all state — an
    // update that leaves an already-`*` row `*` (e.g. a label rename) does
    // not re-warn; it was already logged when the row was created/restored.
    if (normalizedOrigin === ALLOW_ALL_ORIGIN_PATTERN && originBeforeUpdate !== ALLOW_ALL_ORIGIN_PATTERN) {
      this.warnIfAllowAllOrigin(updated.origin, updated.tenantId, 'updated');
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        ...entity.changes,
        previousVersion,
        newVersion: updated.version,
      },
    });

    this.emitOriginRegistryInvalidate();

    return TenantAllowedOriginDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<TenantAllowedOriginResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await this.findOwnedOrThrow(id, tenantId);

    const deleted = await this.tenantAllowedOriginRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: deleted.toObject() as object,
    });

    this.emitOriginRegistryInvalidate();

    return TenantAllowedOriginDtoMapper.toResponse(deleted);
  }

  /**
   * Load by id and enforce tenant ownership. Mismatch (or missing) throws
   * `NotFoundException` — never `ForbiddenException` — so a cross-tenant
   * caller cannot infer the row exists (04-application-services.md: 404-over-403).
   */
  private async findOwnedOrThrow(id: string, tenantId: string): Promise<TenantAllowedOriginEntity> {
    const entity = await this.tenantAllowedOriginRepository.findById(id);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException(`Allowed origin ${id} not found`);
    }
    return entity;
  }

  /**
   * `findByOriginAndTenant` filters to ENABLED rows only (see its
   * repository-level doc comment), so it cannot see a soft-deleted grant
   * occupying the same (origin, tenantId) pair. Scoped to `tenantId`
   * explicitly (§4B) — a soft-deleted grant belonging to a DIFFERENT tenant
   * must never surface here; that tenant's create is a distinct, new grant,
   * not a restore of this one. `findFirst` throws `DataNotFoundException` on
   * a miss in production but is commonly mocked as resolving `null` in tests
   * — both are tolerated here (mirrors `findOwnedOrThrow` / `tenant-guards.ts`'s
   * `findFirstTolerant`, kept local since the repository is W6-A's file, not
   * ours to extend).
   */
  private async findDeletedByOriginAndTenant(origin: string, tenantId: string): Promise<TenantAllowedOriginEntity | null> {
    try {
      const result = await this.tenantAllowedOriginRepository.findFirst({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<TenantAllowedOrigin> would require importing the Prisma-generated model type here.
        where: { origin, tenantId, resourceStatus: ResourceStatusType.DELETED } as any,
      });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  private emitOriginRegistryInvalidate(): void {
    this.eventEmitter.emit(ORIGIN_REGISTRY_INVALIDATE_EVENT);
  }

  /**
   * Writing the `*` row (README §4A.3) admits every origin for the OWNING
   * TENANT — a security-relevant state change, not "one more host". Logged at
   * `warn` (not `debug`), with a fixed, greppable `reason` so it is findable
   * in the audit trail independent of the ordinary create/restore/update log
   * noise. Checked against the value actually PERSISTED, never the raw
   * input — `normalizeOriginPattern` is what decides whether near-miss text
   * like `'* '`/`'**'` becomes this token at all (it never does).
   *
   * Callers decide WHEN this fires (create/restore always call it — a fresh
   * insert or a restore-from-deleted-row can only ever be establishing the
   * state; `update()` gates the call itself so an edit to an ALREADY-`*` row
   * — e.g. a label rename — does not re-warn on every subsequent mutation).
   */
  private warnIfAllowAllOrigin(origin: string, tenantId: string, action: 'created' | 'restored' | 'updated'): void {
    if (origin !== ALLOW_ALL_ORIGIN_PATTERN) {
      return;
    }
    this.logger.warn({
      message: `Allow-all origin ('*') ${action} — admits every origin for the owning tenant`,
      reason: 'origin_allow_all_registered',
      tenantId,
      userId: this.requestUserId,
    });
  }
}
