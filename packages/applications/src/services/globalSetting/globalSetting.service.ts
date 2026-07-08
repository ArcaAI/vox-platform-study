import { BadRequestException, ForbiddenException, Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  ResourceStatusType,
  SysEventType,
  EntityId,
  GlobalSettingEntity,
  GlobalSettingFactory,
  GlobalSettingRepository,
  UserRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { IGlobalSettingService } from './IGlobalSettingService';
import { CreateGlobalSettingRequest, RotateGlobalSettingRequest, UpdateGlobalSettingRequest } from './dto';
import { GlobalSettingDtoMapper, buildSecretSettingFilter } from './globalSetting.dto.mapper';
import { BaseService, FetchResponse, PaginatedQuery, isSuperAdmin, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ICryptoService } from '../crypto/ICryptoService';
import { SecretsService } from '../baseServices/_meta/secrets';

const GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN';

/** TASK-396 — audit action tag written into the reveal SysEvent (never the plaintext). */
export const GLOBAL_SETTING_SECRET_REVEALED = 'GLOBAL_SETTING_SECRET_REVEALED';

/** TASK-445 — audit action tag written into the rotation SysEvent (never the old or new plaintext). */
export const GLOBAL_SETTING_SECRET_ROTATED = 'GLOBAL_SETTING_SECRET_ROTATED';

@Injectable()
export class GlobalSettingService extends BaseService implements IGlobalSettingService {
  constructor(
    private readonly globalSettingRepository: GlobalSettingRepository,
    private readonly userRepository: UserRepository,
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.GlobalSetting);
  }

  async create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    // TASK-402 (Defect 2) — revive-on-create. The DB unique index
    // `(tenantId, name, key)` counts soft-DELETED rows, so a plain create
    // after a soft-delete 409s (P2002) and the key can never come back.
    // When a DELETED row matches the identity the new row would take, RESTORE
    // it (UPDATE: ENABLED + version bump — the sanctioned resurrect path) and
    // apply the request's fields, preserving the row's audit lineage. Follows
    // the userRoleAssignment.service restore-on-create precedent. The tenant
    // is resolved exactly like the write path does (explicit request tenant,
    // else the CLS tenant the tenant-scope extension would inject); with
    // neither, there is no unique identity to collide with — plain create.
    const effectiveTenantId = request.tenantId ?? this.tenantId;
    if (effectiveTenantId) {
      try {
        const deleted = await this.globalSettingRepository.findFirst({
          where: {
            tenantId: effectiveTenantId,
            name: request.name,
            key: request.key,
            resourceStatus: ResourceStatusType.DELETED,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        });

        const restored = await this.globalSettingRepository.restore(deleted.id, this.requestUser?.id);
        await this.updateEntity(restored, {
          value: request.value,
          dataType: request.dataType,
          namespace: request.namespace,
          description: request.description,
        });
        const revived = restored.hasChanges ? await this.globalSettingRepository.update(restored.id, restored) : restored;

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
          resourceId: revived.id,
          createdAt: revived.createdAt,
          data: { ...(revived.toObject() as object), revivedFromDeleted: true },
        });
        return revived;
      } catch (e) {
        if (!(e instanceof DataNotFoundException)) throw e;
        // No DELETED row for this identity — fall through to a plain create.
      }
    }

    const newGlobalSetting = GlobalSettingFactory.CreateGlobalSetting({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    const globalSetting = await this.globalSettingRepository.create(newGlobalSetting);

    if (!globalSetting) {
      throw new InternalServerErrorException(`Failed to create GlobalSettingEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: globalSetting.id,
      createdAt: globalSetting.createdAt,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  /**
   * TASK-443 — resolve the OPTIONAL `secretsOnly` list facet to the shared
   * derived-secret fragment ({@link buildSecretSettingFilter}); there is no
   * `isSecret` column, so this is the only server-side transport for the
   * "Secrets only" chip. `true` narrows to secrets, `false` to non-secrets,
   * `undefined` adds nothing. Extra clauses (the tenant scope) AND in front.
   * The fragment is always wrapped in `AND: [...]` because the repository's
   * `formatFindAllProps` merges a bare top-level `OR` lossily with filters.
   */
  private static resolveListWhere(secretsOnly: boolean | undefined, ...extraClauses: Record<string, unknown>[]): { AND: Record<string, unknown>[] } | undefined {
    if (secretsOnly === undefined) return undefined;
    const secretClause = secretsOnly ? buildSecretSettingFilter() : { NOT: buildSecretSettingFilter() };
    return { AND: [...extraClauses, secretClause] };
  }

  async fetchAll(props: PaginatedQuery & { secretsOnly?: boolean }): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search, secretsOnly } = props;
    // TASK-443 — 'GlobalSetting' opts the list into model-aware filter
    // coercion: `dataType` (enum ValueType) member-validates with a 400 on an
    // unknown member instead of a Prisma server-side error.
    const where = GlobalSettingService.resolveListWhere(secretsOnly);
    const globalSettings = await this.globalSettingRepository.findAll({
      ...withFormattedPaginatedProps(props, 'GlobalSetting'),
      ...(where ? { where } : {}),
    });

    const count = await this.globalSettingRepository.count({
      ...withFormattedCountProps(props, 'GlobalSetting'),
      ...(where ? { where } : {}),
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string; secretsOnly?: boolean }): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search, secretsOnly } = props;
    // TASK-443 — with the secretsOnly facet the tenant scope moves INSIDE the
    // AND group (formatFindAllProps drops sibling keys next to `where.AND`);
    // without it the bare `{ tenantId }` shape is kept byte-for-byte.
    const where = GlobalSettingService.resolveListWhere(secretsOnly, { tenantId }) ?? { tenantId };
    const globalSettings = await this.globalSettingRepository.findAll({
      ...withFormattedPaginatedProps(props, 'GlobalSetting'),
      where,
    });
    const count = await this.globalSettingRepository.count({
      ...withFormattedCountProps(props, 'GlobalSetting'),
      where,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const globalSettings = await this.globalSettingRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.globalSettingRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  async update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.findById(id);

    // TASK-332 — `locked` rows are platform-owned defaults (e.g. the
    // `enable-local-raw-capture` capability). Only a GLOBAL_ADMIN may write
    // them; everyone else is refused BEFORE any mutation. Mirrors the
    // `TenantService.updateTenantConfigs` locked posture.
    if (globalSetting.locked && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Setting '${globalSetting.key}' is locked and can only be modified by ${GLOBAL_ADMIN_ROLE} users.`);
    }

    const previousData = globalSetting.toObject();
    // TASK-302 Stream D Phase C (C.7/C.8) — snapshot the row version BEFORE
    // we mutate the entity so the post-write SysEvent can carry
    // `{ previousVersion, newVersion }` for audit-log correlation.
    const previousVersion = globalSetting.version;
    this.updateEntity(globalSetting, request);

    if (!globalSetting.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // TASK-302 Stream D Phase C (C.7) — Compare-And-Set against `_version`.
    // The `OptimisticConcurrencyException` propagates out so the HTTP layer
    // (Phase D ExceptionFilter) renders `412 Precondition Failed` with
    // `{ currentVersion, expectedVersion }`. No `$transaction` here because
    // this is the single-row path (vs. the multi-row tenant config batch).
    const updatedGlobalSetting = await this.globalSettingRepository.updateWithVersion(id, globalSetting, request.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedGlobalSetting.id,
      // C.8 — carry the version transition in the audit log so downstream
      // observers can correlate previous and new state.
      data: { ...globalSetting.changes, previousVersion, newVersion: updatedGlobalSetting.version },
      previousData,
    });
    return updatedGlobalSetting;
  }

  async deleteById(id: EntityId): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  /**
   * TASK-396 — reveal ONE secret setting's plaintext.
   *
   * Order of guards (fail-closed):
   *   1. Super-admin re-check (defense in depth; the controller's CASL
   *      `manage all` gate is the primary enforcement). Mirrors the `locked`
   *      posture in `update`.
   *   2. Step-up re-auth — verify the caller's CURRENT password against the
   *      stored bcrypt hash (same primitive as login). Password is never logged
   *      and never persisted.
   *   3. Decrypt via the SAME crypto path used to WRITE `encryptedValue`
   *      (`decryptValueFromEntity`, which Transit-decrypts when `encryptedValue`
   *      is present and falls back to the legacy plaintext `value` otherwise).
   *   4. Audit — emit a SysEvent carrying actor/tenant/correlation (from CLS) +
   *      key/id/timestamp. The plaintext is NEVER included.
   */
  async revealSecret(id: EntityId, password: string): Promise<{ entity: GlobalSettingEntity; plaintext: string }> {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Revealing a secret setting requires a ${GLOBAL_ADMIN_ROLE} user.`);
    }

    const userId = this.requestUserId;
    if (!userId) {
      throw new UnauthorizedException('No authenticated user in context.');
    }
    if (!password) {
      throw new UnauthorizedException('Step-up re-authentication requires your current password.');
    }
    const user = await this.userRepository.findById(userId);
    const passwordOk = await this.cryptoService.verify(password, user.password);
    if (!passwordOk) {
      throw new UnauthorizedException('Step-up re-authentication failed: incorrect password.');
    }

    const { entity, plaintext } = await this.globalSettingRepository.findByIdWithDecryptedValue(id, this.secretsService);

    // Audit — NEVER the plaintext. Two constraints force a direct emit here
    // instead of `broadcastSysEvent`:
    //   1. `forceAuditLog: true` — `SysEventService.handleResourceViewedEvent`
    //      drops READ events by default (volume control) and only persists an
    //      `AuditLog` row when this flag is set (the "sensitive/compliance read"
    //      case, which a secret reveal is exactly).
    //   2. tenant attribution — reveal is SUPER-ADMIN-only, and super-admins
    //      carry a NULL CLS `tenantId`. `broadcastSysEvent` always sources the
    //      tenant from CLS (a HIPAA boundary that ignores caller-supplied
    //      tenantId), so the emitted event would be `tenantId: null` and
    //      `AuditLogProcessor` fail-closes on a null tenant — silently dropping
    //      the row. We attribute the audit to the REVEALED RESOURCE's own tenant
    //      (`entity.tenantId`, a persisted DB value — never caller-supplied),
    //      falling back to the CLS tenant when present. This is correct
    //      attribution, not misattribution: the row is tagged with the tenant
    //      that actually owns the secret.
    this.eventEmitter.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      resourceId: entity.id,
      tenantId: this.tenantId ?? entity.tenantId,
      forceAuditLog: true,
      data: {
        action: GLOBAL_SETTING_SECRET_REVEALED,
        key: entity.key,
        namespace: entity.namespace,
        revealedAt: new Date().toISOString(),
      },
    });

    return { entity, plaintext };
  }

  /**
   * TASK-445 — rotate ONE secret setting.
   *
   * v1 semantics (encryption-at-rest is scaffolded but UNWIRED — Phase 4C):
   * an atomic, step-up-gated, distinctly-audited REPLACE-WITH-NEW-VALUE under
   * optimistic concurrency. The secret is operator-supplied (no
   * server-generatable material, unlike an api-key token), so the caller
   * provides the replacement; the old value is invalidated by the SAME
   * versioned write (`updateWithVersion` compare-and-set) — no window where
   * both values are valid. When the Phase 4C encryption write path lands,
   * this is also where `encryptValueIntoEntity` re-wraps `encryptedValue`
   * under a fresh `keyVersion`.
   *
   * Order of guards (fail-closed, mirrors `revealSecret`):
   *   1. Super-admin re-check (primary gate is the controller's CASL
   *      `manage:all`). This also subsumes the `locked`-row guard from
   *      `update` — every caller that reaches the write IS a GLOBAL_ADMIN.
   *   2. Step-up re-auth — verify the caller's CURRENT password against the
   *      stored bcrypt hash. Never logged, never persisted.
   *   3. Secrets only — a non-secret row (per the shared
   *      `GlobalSettingDtoMapper.isSecretEntity` convention) is rejected;
   *      plain values go through the ordinary update PATCH.
   *   4. OCC write — `updateWithVersion` compare-and-set; drift throws
   *      `OptimisticConcurrencyException` → HTTP 412.
   *   5. Audit — force-audited `ResourceUpdated` tagged
   *      `GLOBAL_SETTING_SECRET_ROTATED`. Unlike `update`, the event carries
   *      NEITHER `changes` NOR `previousData` — both would leak the new/old
   *      plaintext. Tenant attribution falls back to the rotated resource's
   *      own persisted tenant (same rationale as the reveal audit).
   */
  async rotateSecret(id: EntityId, request: RotateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Rotating a secret setting requires a ${GLOBAL_ADMIN_ROLE} user.`);
    }

    const userId = this.requestUserId;
    if (!userId) {
      throw new UnauthorizedException('No authenticated user in context.');
    }
    if (!request.password) {
      throw new UnauthorizedException('Step-up re-authentication requires your current password.');
    }
    const user = await this.userRepository.findById(userId);
    const passwordOk = await this.cryptoService.verify(request.password, user.password);
    if (!passwordOk) {
      throw new UnauthorizedException('Step-up re-authentication failed: incorrect password.');
    }

    if (!request.newValue) {
      // NestJS BadRequestException (not ArgumentInvalidException): the
      // ExceptionInterceptor maps BaseException subclasses to a generic 500,
      // and these rotate guards are client-input errors that must render 400.
      throw new BadRequestException('Rotation requires a non-empty replacement value.');
    }

    const globalSetting = await this.globalSettingRepository.findById(id);

    if (!GlobalSettingDtoMapper.isSecretEntity(globalSetting)) {
      throw new BadRequestException(`Setting '${globalSetting.key}' is not a secret — use the standard update instead.`);
    }

    const previousVersion = globalSetting.version;
    await this.updateEntity(globalSetting, { value: request.newValue });
    if (!globalSetting.hasChanges) {
      throw new BadRequestException('The replacement value matches the current secret — nothing to rotate.');
    }

    const rotated = await this.globalSettingRepository.updateWithVersion(id, globalSetting, request.expectedVersion);

    // Audit — direct emit (not `broadcastSysEvent`) for the same two reasons
    // documented on the reveal audit above: `forceAuditLog` must be honored,
    // and the super-admin's CLS tenant is NULL so attribution falls back to
    // the rotated row's own persisted tenant. The plaintext (old AND new) and
    // the step-up password are NEVER included.
    this.eventEmitter.emit(SysEventType.ResourceUpdated, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      resourceId: rotated.id,
      tenantId: this.tenantId ?? rotated.tenantId,
      forceAuditLog: true,
      data: {
        action: GLOBAL_SETTING_SECRET_ROTATED,
        key: rotated.key,
        namespace: rotated.namespace,
        previousVersion,
        newVersion: rotated.version,
        rotatedAt: new Date().toISOString(),
      },
    });

    return rotated;
  }
}
