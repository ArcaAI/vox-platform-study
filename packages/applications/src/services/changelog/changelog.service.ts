import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ChangelogAudience,
  ChangelogEntryEntity,
  ChangelogEntryFactory,
  ChangelogEntryRepository,
  ChangelogPublishStatus,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  UserChangelogAcknowledgementEntity,
  UserChangelogAcknowledgementFactory,
  UserChangelogAcknowledgementRepository,
  UserRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService, FetchResponse, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ChangelogDtoMapper } from './changelog.dto.mapper';
import { IChangelogService } from './IChangelogService';
import {
  ChangelogEntryResponse,
  CreateChangelogEntryRequest,
  ListChangelogQuery,
  PaginatedChangelogEntryResponse,
  UpdateChangelogEntryRequest,
} from './dto';

/** §3.6 rule 2 — the popup shows at most three notes; more than that is noise. */
const UNSEEN_CAP = 3;

/**
 * Window of most-recent published entries considered when computing the
 * unseen set. Entries are one per platform train, so 50 covers years of
 * history while keeping the ack lookup a single bounded query.
 */
const UNSEEN_SCAN_WINDOW = 50;

/**
 * Curated release notes — the "What's New" plane of TASK-648 (§3.5/§3.6).
 *
 * Two distinct surfaces share this service:
 *   • reader surface (`/changelog`, `/changelog/unseen`, `/changelog/acknowledge`)
 *     — any authenticated user; audience filtering happens HERE, not in a
 *     decorator, because the audience is a property of the row, not of the route.
 *   • authoring surface (`/admin/changelog*`) — GLOBAL_ADMIN only, enforced
 *     imperatively below (`assertGlobalAdmin`). The permission decorators cannot
 *     express "global admin only"; this is the documented house pattern
 *     (`05-nestjs-api.md` §Imperative Privilege Checks), and the routes carry an
 *     `// AUTH-NOTE:` marker pointing here.
 *
 * INTEGRATION NOTE (reported to the integrator, NOT fixed here — it lives in
 * `packages/database`, outside this unit's write set): `ChangelogEntry` rows are
 * SYSTEM-tenant owned but the model is listed in `TENANT_SCOPED_MODELS` WITHOUT
 * being in `SYSTEM_SHARED_READ_MODELS`. Until it is added there, a tenant-scoped
 * caller's reads get `tenantId = <their tenant>` injected and see nothing. This
 * service therefore never pins `tenantId` on a read, so it works correctly the
 * moment the shared-read widening lands.
 */
@Injectable()
export class ChangelogService extends BaseService implements IChangelogService {
  constructor(
    private readonly changelogEntryRepository: ChangelogEntryRepository,
    private readonly acknowledgementRepository: UserChangelogAcknowledgementRepository,
    private readonly userRepository: UserRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ChangelogEntry);
  }

  // ---------------------------------------------------------------------------
  // Reader surface
  // ---------------------------------------------------------------------------

  async list(query: ListChangelogQuery): Promise<PaginatedChangelogEntryResponse> {
    const page = query.page ?? 0;
    const limit = query.limit ?? 10;

    // A global admin authors these rows, so they see DRAFTs too; everyone else
    // sees only what a human deliberately published.
    const where: Record<string, unknown> = {
      audience: { in: this.visibleAudiences() },
    };
    if (!this.isGlobalAdmin()) {
      where.publishStatus = ChangelogPublishStatus.PUBLISHED;
    }
    if (query.severity) {
      where.severity = query.severity;
    }
    if (query.version) {
      where.platformVersion = { startsWith: query.version };
    }

    const [entries, count] = await Promise.all([
      this.changelogEntryRepository.findAll({
        where,
        page,
        limit,
        sort: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.changelogEntryRepository.count({ where }),
    ]);

    const acknowledgedIds = await this.acknowledgedIdsFor(entries.map((entry) => entry.id));

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: entries.length } });

    return ChangelogDtoMapper.ToPaginatedResponse(new FetchResponse<ChangelogEntryEntity>({ data: entries, count, page, limit }), acknowledgedIds);
  }

  /**
   * Data source for the one-time "What's New" dialog.
   *
   * Returns an EMPTY ARRAY — never an error — whenever there is nothing to
   * show, so the dialog renders nothing at all.
   */
  async listUnseen(): Promise<ChangelogEntryResponse[]> {
    const user = this.requestUser;
    if (!user?.id) return [];

    // §3.6 rule 4 — NEVER while impersonating. A support session would
    // otherwise write the acknowledgement on behalf of the real user, who then
    // never sees a breaking-change notice.
    if (user.impersonatedBy) return [];

    const published = await this.changelogEntryRepository.findAll({
      where: {
        publishStatus: ChangelogPublishStatus.PUBLISHED,
        audience: { in: this.visibleAudiences() },
      },
      page: 0,
      limit: UNSEEN_SCAN_WINDOW,
      sort: [{ publishedAt: 'desc' }],
    });
    if (published.length === 0) return [];

    const acknowledgedIds = await this.acknowledgedIdsFor(published.map((entry) => entry.id));
    const unacknowledged = published.filter((entry) => !acknowledgedIds.has(entry.id));
    if (unacknowledged.length === 0) return [];

    // §3.6 rule 6 — a new user's first login does not replay history. Entries
    // published before the user existed are auto-acked (flagged, so support can
    // tell "read it" from "predated them") and never shown.
    const userCreatedAt = await this.userCreatedAt(user.id);
    const predating = userCreatedAt ? unacknowledged.filter((entry) => (entry.publishedAt ?? entry.createdAt) < userCreatedAt) : [];
    const showable = userCreatedAt ? unacknowledged.filter((entry) => !predating.includes(entry)) : unacknowledged;

    if (predating.length > 0) {
      await this.writeAcknowledgements(
        user.id,
        predating.map((entry) => entry.id),
        true,
      );
    }

    return showable.slice(0, UNSEEN_CAP).map((entry) => ChangelogDtoMapper.toResponse(entry, false));
  }

  /** Idempotent: acknowledging an already-acknowledged entry is a no-op, not a conflict. */
  async acknowledge(entryIds: string[]): Promise<void> {
    const userId = this.requestUserId;
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (entryIds.length === 0) return;

    const alreadyAcknowledged = await this.acknowledgedIdsFor(entryIds);
    const missing = entryIds.filter((id) => !alreadyAcknowledged.has(id));
    if (missing.length === 0) return;

    await this.writeAcknowledgements(userId, missing, false);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.UserChangelogAcknowledgement,
      data: { changelogEntryIds: missing, userId },
    });
  }

  // ---------------------------------------------------------------------------
  // Authoring surface — GLOBAL_ADMIN only
  // ---------------------------------------------------------------------------

  async create(dto: CreateChangelogEntryRequest): Promise<ChangelogEntryResponse> {
    this.assertGlobalAdmin();

    // Always DRAFT, always SYSTEM-tenant: a release note is platform-wide, and
    // publishing is a separate, explicit human action (§3.5).
    const entity = ChangelogEntryFactory.CreateChangelogEntry({
      tenantId: SYSTEM_TENANT_ID,
      platformVersion: dto.platformVersion,
      title: dto.title,
      summary: dto.summary,
      body: dto.body,
      severity: dto.severity,
      audience: dto.audience,
      publishStatus: ChangelogPublishStatus.DRAFT,
      publishedAt: null,
      createdBy: this.requestUserId ?? undefined,
    });
    entity.validate();

    const saved = await this.changelogEntryRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { platformVersion: saved.platformVersion, publishStatus: saved.publishStatus },
    });

    return ChangelogDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateChangelogEntryRequest): Promise<ChangelogEntryResponse> {
    this.assertGlobalAdmin();

    const entity = await this.changelogEntryRepository.findById(id);
    const previousData = entity.toObject();
    const { expectedVersion, ...editable } = dto;

    await this.updateEntity(entity, editable as UpdateChangelogEntryRequest);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }
    entity.validate();

    const previousVersion = entity.version;
    const updated = await this.changelogEntryRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
      previousData,
    });

    return ChangelogDtoMapper.toResponse(updated);
  }

  /**
   * The ONLY path from DRAFT to PUBLISHED, and always a human action — CI never
   * publishes. Publishing an already-published entry is a 409, not a silent
   * re-broadcast.
   */
  async publish(id: string, expectedVersion?: number): Promise<ChangelogEntryResponse> {
    this.assertGlobalAdmin();

    const entity = await this.changelogEntryRepository.findById(id);
    if (entity.publishStatus === ChangelogPublishStatus.PUBLISHED) {
      throw new ConflictException(`Changelog entry ${id} is already published`);
    }

    const previousData = entity.toObject();
    const previousVersion = entity.version;
    entity.publishStatus = ChangelogPublishStatus.PUBLISHED;
    entity.publishedAt = new Date();
    entity.updatedBy = this.requestUserId ?? undefined;
    entity.validate();

    const updated = await this.changelogEntryRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { publishStatus: updated.publishStatus, previousVersion, newVersion: updated.version },
      previousData,
    });

    return ChangelogDtoMapper.toResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private isGlobalAdmin(): boolean {
    return isSuperAdmin(this.requestUser);
  }

  /**
   * AUTH-NOTE: the route decorators declare `manage:ChangelogEntry`, which a
   * tenant admin could legitimately hold; the REAL gate on every authoring
   * route is this global-admin check. A release note is a platform-wide
   * broadcast — a tenant admin must never author or publish one. This is a 403
   * privilege boundary, not the 404-over-403 cross-tenant posture.
   */
  private assertGlobalAdmin(): void {
    if (!this.isGlobalAdmin()) {
      throw new ForbiddenException('Only a global administrator may author release notes');
    }
  }

  private visibleAudiences(): ChangelogAudience[] {
    return this.isGlobalAdmin() ? [ChangelogAudience.ALL, ChangelogAudience.GLOBAL_ADMIN] : [ChangelogAudience.ALL, ChangelogAudience.TENANT_ADMIN];
  }

  private async acknowledgedIdsFor(entryIds: string[]): Promise<Set<string>> {
    const userId = this.requestUserId;
    if (!userId || entryIds.length === 0) return new Set();

    const rows = await this.acknowledgementRepository.findAll({
      where: { userId, changelogEntryId: { in: entryIds } },
      limit: entryIds.length,
    });
    return new Set(rows.map((row: UserChangelogAcknowledgementEntity) => row.changelogEntryId));
  }

  private async writeAcknowledgements(userId: string, entryIds: string[], autoAcknowledged: boolean): Promise<void> {
    const tenantId = this.tenantId ?? this.requestUser?.tenantId ?? SYSTEM_TENANT_ID;
    const rows = entryIds.map((changelogEntryId) =>
      UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement({
        tenantId,
        userId,
        changelogEntryId,
        autoAcknowledged,
        createdBy: userId,
      }),
    );
    // `skipDuplicates` keeps a concurrent double-dismiss (two tabs) idempotent
    // at the DB level, not just in the read-then-write above.
    await this.acknowledgementRepository.createMany(rows, true);
  }

  private async userCreatedAt(userId: string): Promise<Date | null> {
    try {
      const user = await this.userRepository.findById(userId);
      return user?.createdAt ?? null;
    } catch {
      // A missing user row must not turn the popup into an error surface.
      return null;
    }
  }
}
