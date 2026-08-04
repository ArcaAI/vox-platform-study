import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class TenantAllowedOriginService extends BaseService implements ITenantAllowedOriginService {
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

    // Origin SYNTAX is decided exclusively by `normalizeOrigin` (README §3.3)
    // — the NORMALIZED form, never the raw input, is what gets checked and
    // persisted. Throws `ArgumentInvalidException` on anything malformed.
    const normalized = normalizeOrigin(dto.origin);

    // A LIVE row on this origin is a genuine duplicate — reject it up front.
    const liveExisting = await this.tenantAllowedOriginRepository.findByOrigin(normalized.origin);
    if (liveExisting) {
      throw new ConflictException(`Origin '${normalized.origin}' is already registered.`);
    }

    // The DB's global unique index on `origin` is NOT partial (see the
    // schema comment on `TenantAllowedOrigin_origin_unique`), so a
    // soft-deleted row still occupies the value — `findByOrigin` only sees
    // ENABLED rows and cannot see it. A delete -> re-add must RESTORE that
    // row (one row per origin is what the index requires anyway), never
    // insert a second one, and never refuse with a "conflict" the admin list
    // cannot explain (the origin appears nowhere, yet create says it's taken).
    const deletedExisting = await this.findDeletedByOrigin(normalized.origin);
    if (deletedExisting) {
      return this.restoreOnCreateCollision(deletedExisting, dto);
    }

    const entity = TenantAllowedOriginFactory.CreateTenantAllowedOrigin({
      tenantId,
      origin: normalized.origin,
      label: dto.label,
      description: dto.description,
      createdBy: this.requestUserId ?? undefined,
    });

    let saved: TenantAllowedOriginEntity;
    try {
      saved = await this.tenantAllowedOriginRepository.create(entity);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Check-then-write race: the row transitioned between our checks and
        // this write. Retry the soft-deleted lookup once — a concurrent
        // delete could have landed in that exact window — before concluding
        // it's a live duplicate.
        const raced = await this.findDeletedByOrigin(normalized.origin);
        if (raced) {
          return this.restoreOnCreateCollision(raced, dto);
        }
        throw new ConflictException(`Origin '${normalized.origin}' is already registered.`);
      }
      throw err;
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { origin: saved.origin, label: saved.label },
    });

    this.emitOriginRegistryInvalidate();

    return TenantAllowedOriginDtoMapper.toResponse(saved);
  }

  /**
   * Reinstate a soft-deleted row that occupies the requested origin, rather
   * than inserting a second row the global unique index would reject. Treated
   * as a successful CREATE from the caller's perspective: the reinstated row
   * carries the NEW `label`/`description` from this request, not whatever was
   * there before the delete (a delete -> re-add is a fresh registration, not
   * a resurrection of stale metadata — `description` uses `?? null`, not
   * `undefined`, so an omitted note actually clears the old one instead of
   * being skipped by `applyChangesToEntity`'s undefined-is-noop rule).
   *
   * Mirrors the `GlobalSettingService.create` revive-on-create precedent
   * (restore → apply fields → non-versioned `update` only if changed).
   */
  private async restoreOnCreateCollision(
    deletedEntity: TenantAllowedOriginEntity,
    dto: CreateTenantAllowedOriginRequest,
  ): Promise<TenantAllowedOriginResponse> {
    const restored = await this.tenantAllowedOriginRepository.restore(deletedEntity.id, this.requestUserId ?? undefined);

    await this.updateEntity(restored, {
      label: dto.label,
      description: dto.description ?? null,
    });

    const saved = restored.hasChanges ? await this.tenantAllowedOriginRepository.update(restored.id, restored) : restored;

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

    // Re-normalize `origin` when the DTO changes it (README §3.3 "Re-normalize
    // origin if the DTO changes it"). Skip the duplicate check entirely when
    // the normalized value is identical to the row's current value — that is
    // not a collision with ANOTHER row, just a no-op/idempotent re-submit.
    let normalizedOrigin: string | undefined;
    if (origin !== undefined) {
      normalizedOrigin = normalizeOrigin(origin).origin;
      if (normalizedOrigin !== entity.origin) {
        const existing = await this.tenantAllowedOriginRepository.findByOrigin(normalizedOrigin);
        if (existing && existing.id !== id) {
          throw new ConflictException(`Origin '${normalizedOrigin}' is already registered.`);
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
        throw new ConflictException(`Origin '${normalizedOrigin}' is already registered.`);
      }
      throw err;
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
   * `findByOrigin` filters to ENABLED rows only (see its repository-level
   * doc comment), so it cannot see a soft-deleted row occupying the same
   * origin. `findFirst` throws `DataNotFoundException` on a miss in
   * production but is commonly mocked as resolving `null` in tests — both
   * are tolerated here (mirrors `findOwnedOrThrow` / `tenant-guards.ts`'s
   * `findFirstTolerant`, kept local since the repository is W1-C's file, not
   * ours to extend).
   */
  private async findDeletedByOrigin(origin: string): Promise<TenantAllowedOriginEntity | null> {
    try {
      const result = await this.tenantAllowedOriginRepository.findFirst({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<TenantAllowedOrigin> would require importing the Prisma-generated model type here.
        where: { origin, resourceStatus: ResourceStatusType.DELETED } as any,
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
}
