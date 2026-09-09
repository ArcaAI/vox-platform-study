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
  SYSTEM_TENANT_ID,
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

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** Audit action tag written into the reveal SysEvent (never the plaintext). */
export const GLOBAL_SETTING_SECRET_REVEALED = 'GLOBAL_SETTING_SECRET_REVEALED';

/** Audit action tag written into the rotation SysEvent (never the old or new plaintext). */
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

  /**
   * TASK-890 §3.15 (OD-P) — the PLATFORM TIER of a tenant-manageable resource.
   *
   * `manage:GlobalSetting` is a tenant-admin grant, and the SYSTEM-tenant rows
   * are the platform defaults every tenant inherits when it has no opinion of
   * its own. A route decorator expresses `action + subject` and cannot express
   * "…except the platform's own rows", so the boundary is imperative — the same
   * shape as `SettingsRegistryWriteService.assertMayWriteAtScope` and
   * `AiProviderConnectionService.assertWriteAllowed`.
   *
   * A 403, not a 404: the caller may legitimately READ this row (it is the
   * default serving its own tenant), so there is nothing to hide — the rule is
   * "you may not write this", not "this may not exist". The 404-over-403
   * posture still governs a row owned by another CUSTOMER tenant, and every
   * call site here loads the row FIRST so that distinction survives.
   *
   * Until now a tenant admin was stopped only emergently: the context
   * interceptor refuses a foreign `x-tenant-id`, and the scope extension throws
   * a raw `Error` on a tenant mismatch — a 400 or a 500 where the answer is a
   * 403, and neither is a guard anybody declared.
   */
  private assertPlatformTierWrite(targetTenantId: string | null | undefined): void {
    if (targetTenantId === SYSTEM_TENANT_ID && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Platform-wide settings are managed by super administrators only.');
    }
  }

  /**
   * TASK-932 R-1 (D-5) — the tenant a non-elevated caller's READS are pinned to,
   * or `null` when the caller is a platform administrator.
   *
   * `GlobalSetting` is a member of `SYSTEM_SHARED_READ_MODELS`
   * (`packages/database/src/extensions/tenant-scope.ts`), so a read that names
   * no tenant is WIDENED to `tenantId IN [caller, SYSTEM]`. That is exactly
   * right for the resolvers that inherit a platform default on ABSENCE, and
   * exactly wrong for this admin surface, which lists ROWS: the platform's own
   * configuration arrives interleaved with the tenant's, and the owner rule is
   * that platform settings are the platform administrator's alone.
   *
   * The fix belongs here and not in the shared-read set, which the inheriting
   * resolvers still depend on. An EXPLICIT `where.tenantId` defeats the
   * widening — `mergeSharedReadTenantIntoWhere` returns early once the caller
   * has pinned one — the same technique `AiProviderConnectionService.readTier`
   * uses to address one tier at a time.
   *
   * A platform administrator is deliberately NOT pinned: unscoped they read
   * every row, and with a working tenant selected the controller already routes
   * them through `fetchAllByTenantId` for that tenant.
   */
  private get ownTenantReadPin(): string | null {
    if (isSuperAdmin(this.requestUser)) return null;
    return this.tenantId;
  }

  /**
   * Envelope-encrypt a SECRET setting's plaintext `value`
   * into `encryptedValue` under the CURRENT Vault Transit key version, so the
   * ciphertext the reveal path prefers always reflects the latest value (and,
   * after a Transit key rotation, the freshest key version — this is the
   * "re-wrap"). Called from every secret value-write (create / update / rotate)
   * so `encryptedValue` is present ⟺ it decrypts to the current value.
   *
   * Gated: secrets only (non-secret config stays plaintext), and only when the
   * provider exposes Transit (env / aws / azure / in-memory have none). The
   * plaintext `value` column is deliberately RETAINED as the dual-read fallback
   * — its removal is a user-gated future change. When the value just changed but no
   * Transit is available, any prior ciphertext is now stale, so it is cleared
   * so the read path falls back to the fresh plaintext instead of decrypting
   * the previous secret. Mutates the entity via the tracked setters, so the
   * caller's `create` / `updateWithVersion` persists it.
   */
  private async applySecretEncryption(entity: GlobalSettingEntity): Promise<void> {
    if (!GlobalSettingDtoMapper.isSecretEntity(entity)) return;
    if (this.secretsService.supportsTransit() && entity.value) {
      await this.globalSettingRepository.encryptValueIntoEntity(entity, this.secretsService);
    } else if (entity.encryptedValue) {
      entity.encryptedValue = null;
      entity.keyVersion = null;
    }
  }

  /**
   * TASK-932 S2-1 — the one row `(tenantId, key)` may have, in ANY namespace.
   *
   * `null` when there is none. `DataNotFoundException` is the repository's way
   * of saying "no match" on `findFirst`, so it is translated here rather than
   * left to a `try` around business logic; every other failure propagates,
   * because a probe that could not run must never be read as "the key is free".
   *
   * `deleted: false` passes NO `resourceStatus`, which is what makes it a LIVE
   * probe: the soft-delete extension injects `not: 'DELETED'` whenever the
   * caller has not pinned one (`applySoftDeleteFilter`, `packages/database`).
   */
  private async findByTenantAndKey(tenantId: string, key: string, deleted: boolean): Promise<GlobalSettingEntity | null> {
    try {
      return await this.globalSettingRepository.findFirst({
        where: {
          tenantId,
          key,
          ...(deleted ? { resourceStatus: ResourceStatusType.DELETED } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
    } catch (e) {
      if (e instanceof DataNotFoundException) return null;
      throw e;
    }
  }

  async create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    // (Defect 2) — revive-on-create. The DB unique index counts soft-DELETED
    // rows, so a plain create after a soft-delete 409s (P2002) and the key can
    // never come back. When a DELETED row matches the identity the new row
    // would take, RESTORE it (UPDATE: ENABLED + version bump — the sanctioned
    // resurrect path) and apply the request's fields, preserving the row's
    // audit lineage. Follows the userRoleAssignment.service restore-on-create
    // precedent. The tenant is resolved exactly like the write path does
    // (explicit request tenant, else the CLS tenant the tenant-scope extension
    // would inject); with neither, there is no unique identity to collide with
    // — plain create.
    //
    // TASK-932 S2-1 — BOTH probes are keyed on `(tenantId, key)` and NOT on
    // `(tenantId, name, key)`. The narrower identity was the old unique index's
    // shape, and it left the platform's real invariant unguarded: the same key
    // under a different `name`/`namespace` is a different row to that index and
    // a DUPLICATE to everything that reads a setting BY KEY. `AppSettingsService`
    // rebuilds its cache keyed by key alone and refuses the whole cache when it
    // finds two ("duplicate platform key(s) detected"), so a second row does not
    // shadow one setting — it takes the settings cache down for the process.
    // Lane S1 adds the DB unique index; this guard is what turns that index's
    // P2002 (which names neither namespace) into a 400 that says which one
    // already holds the key.
    const effectiveTenantId = request.tenantId ?? this.tenantId;
    // TASK-890 §3.15 — before the probes, so a soft-deleted SYSTEM row is
    // not a back door into the platform tier.
    this.assertPlatformTierWrite(effectiveTenantId);
    if (effectiveTenantId) {
      const occupant = await this.findByTenantAndKey(effectiveTenantId, request.key, false);
      if (occupant) {
        throw new ArgumentInvalidException(
          `Setting key '${request.key}' already exists for this tenant in namespace ` +
            `'${occupant.namespace ?? '(none)'}' (name '${occupant.name}'). A tenant holds at most one live row per key — ` +
            'update that row instead of creating a second one.',
        );
      }

      const deleted = await this.findByTenantAndKey(effectiveTenantId, request.key, true);
      if (deleted) {
        const restored = await this.globalSettingRepository.restore(deleted.id, this.requestUser?.id);
        // `name` is applied with the rest since the probe no longer matches on
        // it: a caller that asked for one identity must not silently inherit
        // the buried row's.
        await this.updateEntity(restored, {
          name: request.name,
          value: request.value,
          dataType: request.dataType,
          namespace: request.namespace,
          description: request.description,
        });
        // Encrypt the revived secret's value at rest.
        await this.applySecretEncryption(restored);
        const revived = restored.hasChanges ? await this.globalSettingRepository.update(restored.id, restored) : restored;

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
          resourceId: revived.id,
          createdAt: revived.createdAt,
          data: { ...(revived.toObject() as object), revivedFromDeleted: true },
        });
        return revived;
      }
    }

    const newGlobalSetting = GlobalSettingFactory.CreateGlobalSetting({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    // Encrypt a new secret at rest from birth (no-op for
    // non-secrets / no Transit).
    await this.applySecretEncryption(newGlobalSetting);

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
   * Resolve the OPTIONAL `secretsOnly` list facet to the shared
   * derived-secret fragment ({@link buildSecretSettingFilter}); there is no
   * `isSecret` column, so this is the only server-side transport for the
   * "Secrets only" chip. `true` narrows to secrets, `false` to non-secrets,
   * `undefined` adds nothing. Extra clauses (the tenant scope) AND in front.
   * The fragment is always wrapped in `AND: [...]` because the repository's
   * `formatFindAllProps` merges a bare top-level `OR` lossily with filters.
   */
  private static resolveListWhere(
    secretsOnly: boolean | undefined,
    ...extraClauses: Record<string, unknown>[]
  ): { AND: Record<string, unknown>[] } | undefined {
    if (secretsOnly === undefined) return undefined;
    const secretClause = secretsOnly ? buildSecretSettingFilter() : { NOT: buildSecretSettingFilter() };
    return { AND: [...extraClauses, secretClause] };
  }

  async fetchAll(props: PaginatedQuery & { secretsOnly?: boolean }): Promise<FetchResponse<GlobalSettingEntity>> {
    const { limit, page, secretsOnly } = props;
    // TASK-932 R-1 — a non-elevated caller reads its OWN tenant and nothing
    // else. Without the explicit pin the shared-read widening serves the SYSTEM
    // platform rows alongside the tenant's own (see `ownTenantReadPin`).
    const pin = this.ownTenantReadPin;
    const tenantClause = pin ? { tenantId: pin } : undefined;
    // 'GlobalSetting' opts the list into model-aware filter
    // coercion: `dataType` (enum ValueType) member-validates with a 400 on an
    // unknown member instead of a Prisma server-side error.
    const where = GlobalSettingService.resolveListWhere(secretsOnly, ...(tenantClause ? [tenantClause] : [])) ?? tenantClause;
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
    const { tenantId, limit, page, secretsOnly } = props;
    // TASK-932 R-1 — a non-elevated caller may only ask about its OWN tenant.
    // `where: { tenantId: SYSTEM }` is accepted by the shared-read merge
    // (SYSTEM is half of the `[caller, SYSTEM]` pair it allows), so without
    // this guard `GET admin/settings/tenant/00000000-…` hands a tenant admin
    // the whole platform tier. 404 rather than 403: which tenants exist, and
    // whether the platform tier is readable at all, are existence questions
    // (the house 404-over-403 posture) — a foreign CUSTOMER tenant answers the
    // same way, where the scope extension previously threw a raw 500.
    const pin = this.ownTenantReadPin;
    if (pin && tenantId !== pin) {
      throw new DataNotFoundException('globalSetting', tenantId);
    }
    // With the secretsOnly facet the tenant scope moves INSIDE the
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
    const { userId, limit, page } = props;
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

    // TASK-932 R-1 — the shared-read widening lets a tenant admin's `findById`
    // resolve a SYSTEM row, so the row has to be checked after it is loaded.
    // A 404 (`DataNotFoundException` → the global filter's generic
    // `Resource not found`) and NOT a 403: the answer must be byte-identical to
    // a genuinely missing id, or an admin who can read the platform's key names
    // out of the source tree can confirm each row's existence one request at a
    // time. The guard precedes the audit event on purpose — a read that is
    // refused is not a view.
    const pin = this.ownTenantReadPin;
    if (pin && globalSetting.tenantId !== pin) {
      throw new DataNotFoundException('globalSetting', String(id));
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  async update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.findById(id);

    // TASK-890 §3.15 — EXISTENCE first (the load above 404s), privilege second.
    // Gating before the lookup would make an unknown id 403 while a real
    // foreign id stays 404, handing the caller an existence oracle over the id
    // space (rule 05 §Imperative Privilege Checks).
    this.assertPlatformTierWrite(globalSetting.tenantId);

    // `locked` rows are platform-owned defaults (e.g. the
    // `enable-local-raw-capture` capability). Only a SUPER_ADMIN may write
    // them; everyone else is refused BEFORE any mutation. Mirrors the
    // `TenantService.updateTenantConfigs` locked posture.
    if (globalSetting.locked && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Setting '${globalSetting.key}' is locked and can only be modified by ${SUPER_ADMIN_ROLE} users.`);
    }

    const previousData = globalSetting.toObject();
    // (C.7/C.8) — snapshot the row version BEFORE
    // we mutate the entity so the post-write SysEvent can carry
    // `{ previousVersion, newVersion }` for audit-log correlation.
    const previousVersion = globalSetting.version;
    this.updateEntity(globalSetting, request);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(globalSetting, request.expectedVersion);
    if (!globalSetting.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // When a SECRET's value changes on the ordinary
    // update path, re-wrap its ciphertext (or drop a now-stale ciphertext when
    // Transit is unavailable) so a later reveal never decrypts a previous
    // value. No-op for non-secrets and for value-unchanged edits (e.g. a
    // description-only PATCH keeps the existing ciphertext valid).
    if ('value' in globalSetting.changes) {
      await this.applySecretEncryption(globalSetting);
    }

    // Compare-And-Set against `_version`.
    // The `OptimisticConcurrencyException` propagates out so the HTTP layer
    // (the ExceptionFilter) renders `412 Precondition Failed` with
    // `{ currentVersion, expectedVersion }`. No `$transaction` here because
    // this is the single-row path (vs. the multi-row tenant config batch).
    const updatedGlobalSetting = await this.globalSettingRepository.updateWithVersion(id, globalSetting, request.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedGlobalSetting.id,
      // Carry the version transition in the audit log so downstream
      // observers can correlate previous and new state.
      data: { ...globalSetting.changes, previousVersion, newVersion: updatedGlobalSetting.version },
      previousData,
    });
    return updatedGlobalSetting;
  }

  async deleteById(id: EntityId): Promise<GlobalSettingEntity> {
    // TASK-890 §3.15 — the load is what makes the ORDER right: a foreign id 404s
    // here, and only a row that exists and belongs to the platform tier reaches
    // the 403. The previous blind soft-delete could not tell the two apart.
    const existing = await this.globalSettingRepository.findById(id);
    this.assertPlatformTierWrite(existing.tenantId);

    const globalSetting = await this.globalSettingRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  /**
   * Reveal ONE secret setting's plaintext.
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
      throw new ForbiddenException(`Revealing a secret setting requires a ${SUPER_ADMIN_ROLE} user.`);
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
   * Rotate ONE secret setting.
   *
   * Semantics: an atomic, step-up-gated, distinctly-audited REPLACE-WITH-NEW-
   * VALUE under optimistic concurrency. The secret is operator-supplied (no
   * server-generatable material, unlike an api-key token), so the caller
   * provides the replacement; the old value is invalidated by the SAME
   * versioned write (`updateWithVersion` compare-and-set) — no window where
   * both values are valid. The envelope re-wrap:
   * `applySecretEncryption` encrypts the new value into `encryptedValue` under
   * the current Transit key version in the same write (no-op without Transit).
   *
   * Order of guards (fail-closed, mirrors `revealSecret`):
   *   1. Super-admin re-check (primary gate is the controller's CASL
   *      `manage:all`). This also subsumes the `locked`-row guard from
   *      `update` — every caller that reaches the write IS a SUPER_ADMIN.
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
      throw new ForbiddenException(`Rotating a secret setting requires a ${SUPER_ADMIN_ROLE} user.`);
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
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(globalSetting, request.expectedVersion);
    if (!globalSetting.hasChanges) {
      throw new BadRequestException('The replacement value matches the current secret — nothing to rotate.');
    }

    // Envelope re-wrap: encrypt the new value into
    // `encryptedValue` under the current Transit key version BEFORE the CAS
    // write, so the ciphertext is refreshed atomically with the value in the
    // single versioned write. No-op when Transit is unavailable (plaintext
    // replace, unchanged legacy behavior).
    await this.applySecretEncryption(globalSetting);

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
