import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { GlobalSettingRepository, ResourceType, SysEventType, ValueType } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IGlobalSettingService } from '../globalSetting/IGlobalSettingService';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import { SettingDataType, SettingDescriptor, SettingScope } from './registry.types';

/**
 * The reserved namespace for registry-lane writes. Keeps this lane's rows
 * distinct from the pre-existing `GlobalSettingController` row CRUD (same
 * table, two write paths) until that legacy surface is reconciled.
 */
export const REGISTRY_SETTING_NAMESPACE = 'registry';

/** Platform-owned KV rows live on the reserved global tenant, like rate-limit.*. */
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/** The reserved SYSTEM tenant. Platform capability rows are seeded here. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Tenants that own PLATFORM configuration. A `tenant`-scope write may never
 * target one of these: it would land in the key-only (platform) lane of the
 * settings cache and silently become a platform-wide change (that
 * lane is sound only because its contents are platform-only). Mirrors
 * `PLATFORM_TENANT_IDS` in `AppSettingsService`.
 */
const PLATFORM_TENANT_IDS: readonly string[] = [GLOBAL_TENANT_ID, SYSTEM_TENANT_ID];

export interface WriteRegistrySettingOptions {
  /** Scope the value is being set at. Defaults to `system` for global-kv keys. */
  scope?: SettingScope;
  /**
   * The row version the caller last observed, folded from
   * `If-Match` by the controller (house pattern). REQUIRED when a backing row
   * already exists: without it the write is refused 428 rather than blindly
   * overwriting a concurrent edit. Absent on a FIRST write, where there is no
   * version to match.
   */
  expectedVersion?: number;
}

export interface WriteRegistrySettingResult {
  key: string;
  tier: string;
  value: unknown;
  scope: SettingScope;
  /**
   * The row version AFTER this write. Echoed so the caller can use
   * it as the next `If-Match`, and so the `ETagInterceptor` renders an ETag on
   * this response (it keys off a top-level positive-integer `version`).
   */
  version: number;
}

/**
 * The settings WRITE LANE (a single enforcement point).
 *
 * Before this service there was no write route for ANY registry key anywhere in
 * the gateway: descriptors declared `globalOnly` / `editableBy` / `maxScope`,
 * and nothing consumed them. `SettingsRegistry.assertWithinMaxScope` had ZERO
 * production callers (the pipeline-policy service re-implemented the clamp by
 * hand). This service is its first.
 *
 * Every guard below reads DESCRIPTOR METADATA — there is deliberately no
 * per-key allow-list in this file, so registering a new descriptor is the only
 * thing needed to make a key governed and writable.
 *
 * The PUT flow, in order:
 *   1. unknown key                → 400
 *   2. `sensitivity === 'secret'` → 400 (secrets never flow through this lane)
 *   3. `globalOnly` + not global admin → 403
 *   4. `assertWithinMaxScope`     → 400 on a too-deep scope
 *   5. tier dispatch              → 400 for anything but `global-kv`
 *   6. value validated against `dataType`
 *   7. upsert the backing row, broadcast a sys-event, refresh the read cache
 */
@Injectable()
export class SettingsRegistryWriteService extends BaseService {
  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    @Inject(IGlobalSettingService) private readonly globalSettings: IGlobalSettingService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Direct repository access for a FRESH row read. The CAS
    // version must never come from the AppSettings snapshot: that map is rebuilt
    // on a 45s cron, so two admins editing inside one window would compare
    // against the same stale number and the second would silently clobber the
    // first. Reading the row here costs one indexed lookup per write.
    private readonly globalSettingRepository: GlobalSettingRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.GlobalSetting);
  }

  async write(key: string, value: unknown, options: WriteRegistrySettingOptions = {}): Promise<WriteRegistrySettingResult> {
    // 1. Unknown key. `getOrThrow` throws a bare Error, so translate it into
    //    the domain exception the filters map to 400.
    const descriptor = this.getDescriptorOrThrow(key);

    // 2. Secrets never traverse this lane — mirrors the same refusal in
    //    `EffectiveSettingsService.resolveEffective`.
    if (descriptor.sensitivity === 'secret') {
      throw new ArgumentInvalidException(`Setting '${key}' is a secret; secret values are never written through the settings registry lane.`);
    }

    // 3. Privilege boundary, DESCRIPTOR-DRIVEN. 403 not 404: the caller can
    //    already READ this key through the catalog; only the write is gated.
    if (descriptor.globalOnly && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Setting '${key}' is managed by global administrators only.`);
    }

    // 4. The max-scope clamp — THE enforcement point (first production caller).
    const scope: SettingScope = options.scope ?? 'system';
    HOPE_SETTINGS_REGISTRY.assertWithinMaxScope(key, scope);

    // 4b. WHICH ROW this write targets. `globalOnly` gates the
    //     KEY; this gates the SCOPE, and the two are independent: a key a tenant
    //     admin may set for ITSELF (`rateLimit.maxRequests`) is still a
    //     platform-wide change when written at `system` scope. Previously a
    //     `scope: 'tenant'` write passed the clamp and then wrote the PLATFORM
    //     row regardless — the clamp said yes and the value landed in the wrong
    //     place.
    this.assertMayWriteAtScope(scope, key);
    const targetTenantId = this.targetTenantFor(scope, key);

    // 5. Tier dispatch. `db-config` keys (pipeline policy, TTS config) keep
    //    their dedicated services until those adopt this enforcement point;
    //    refusing here is deliberate, not an oversight.
    if (descriptor.tier !== 'global-kv') {
      throw new ArgumentInvalidException(
        `Tier '${descriptor.tier}' is not writable through the registry lane (yet). ` + `Setting '${key}' is managed by its dedicated service.`,
      );
    }

    // 6. Type validation against the declared dataType.
    const { serialized, valueType } = this.serialize(descriptor, value);

    // 7. Upsert the backing row under COMPARE-AND-SET, then refresh the read cache.
    const existing = await this.findBackingRow(key, targetTenantId);
    const persisted = existing
      ? await this.updateExisting(existing, serialized, options.expectedVersion, key)
      : await this.createOrRecoverRace(key, descriptor, serialized, valueType, targetTenantId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: persisted.id,
      data: {
        key,
        scope,
        tier: descriptor.tier,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId: targetTenantId,
        newVersion: persisted.version,
      },
    });

    await this.appSettings.refreshCache();

    return { key, tier: descriptor.tier, value, scope, version: persisted.version };
  }

  /**
   * Current version of the backing row for `key`, or 0 when none is stored yet.
   *
   * Public so the READ route can carry it, letting the `ETagInterceptor` render
   * an ETag the client echoes as `If-Match` on the write. 0 deliberately yields
   * no ETag — there is nothing to precondition a first write against.
   */
  async getBackingRowVersion(key: string, scope: SettingScope = 'system'): Promise<number> {
    // Deliberately does NOT assert the write privilege: rendering an ETag is a
    // READ, and a tenant admin must be able to read the version of a key it is
    // allowed to write. A tenant-scope read with no working tenant reports "no
    // row" rather than erroring — a GET must not 400 because the caller has not
    // picked a tenant yet.
    let tenantId: string;
    try {
      tenantId = this.targetTenantFor(scope, key);
    } catch {
      return 0;
    }
    const row = await this.findBackingRow(key, tenantId);
    return row?.version ?? 0;
  }

  /**
   * The privilege boundary on the SCOPE of a write.
   *
   * A `system`-scope write changes the value platform-wide, so it is
   * GLOBAL-ADMIN-ONLY regardless of `globalOnly` — which gates the KEY, not the
   * scope. This is a 403 (privilege), never the 404-over-403 cross-tenant
   * posture: the caller may legitimately hold `manage` on the key for its OWN
   * tenant, and is being refused only the platform-wide row.
   *
   * Kept SEPARATE from `targetTenantFor` so a read path can resolve which row
   * it is looking at without inheriting a write's privilege check.
   */
  private assertMayWriteAtScope(scope: SettingScope, key: string): void {
    if (scope === 'system' && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Writing setting '${key}' at 'system' scope changes it platform-wide and is restricted to global administrators.`);
    }
  }

  /**
   * The tenant whose row `scope` addresses. Pure row targeting — no privilege
   * check (see `assertMayWriteAtScope`).
   *
   *  - `system`  → the reserved platform tenant.
   *  - `tenant`  → the caller's WORKING tenant, taken from CLS. Deliberately
   *    not a caller-supplied id: the Prisma tenant-scope extension pins every
   *    `GlobalSetting` write to the CLS tenant anyway, so accepting a target id
   *    here would advertise a cross-tenant write path that cannot execute. A
   *    global admin acting for a tenant already carries that tenant in CLS (the
   *    console's `X-Tenant-Id` working-tenant header).
   *
   * `department` / `doctor` are refused: no key declares a deeper `maxScope`
   * than `tenant` in this tier, and inventing a row layout for a scope with no
   * descriptor would be speculative.
   */
  private targetTenantFor(scope: SettingScope, key: string): string {
    if (scope === 'system') {
      return GLOBAL_TENANT_ID;
    }
    if (scope !== 'tenant') {
      throw new ArgumentInvalidException(`Setting '${key}' cannot be written at '${scope}' scope through the registry lane.`);
    }

    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException(`Writing setting '${key}' at 'tenant' scope requires a working tenant; none is selected for this request.`);
    }
    if (PLATFORM_TENANT_IDS.includes(tenantId)) {
      throw new ArgumentInvalidException(
        `Writing setting '${key}' at 'tenant' scope requires a CUSTOMER tenant; ` +
          'the reserved platform tenants hold the platform-wide row, which is written at `system` scope.',
      );
    }
    return tenantId;
  }

  /**
   * The backing KV row for `key` under `tenantId`, read FRESH (never the
   * AppSettings snapshot).
   */
  private async findBackingRow(key: string, tenantId: string): Promise<{ id: string; version: number } | null> {
    // `Repository.findFirst` THROWS `DataNotFoundException` on no match (it
    // never returns null) — on a fresh DB with no registry rows that exception
    // used to escape as a blanket 404 on every `GET registry/:key`.
    // "No backing row yet" is a normal state here (code-default /
    // first write), so it maps to null, not an error.
    try {
      const row = await this.globalSettingRepository.findFirst({
        where: { key, namespace: REGISTRY_SETTING_NAMESPACE, tenantId },
      } as never);
      return row ? { id: row.id, version: row.version } : null;
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * CAS an existing row. `expectedVersion` is mandatory here — a write with no
   * precondition against a row that already exists is exactly the blind
   * overwrite RFC 7232 defines 428 for.
   */
  private async updateExisting(
    existing: { id: string; version: number },
    serialized: string,
    expectedVersion: number | undefined,
    key: string,
  ): Promise<{ id: string; version: number }> {
    if (expectedVersion === undefined) {
      // RFC 6585 §3 — mirrors the shape `extractExpectedVersion` throws at the
      // HTTP layer, so a caller sees one consistent 428 contract whether the
      // header was omitted on an annotated route or reached the service unset.
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          code: 'HTTP.PRECONDITION_REQUIRED',
          message:
            `Setting '${key}' already has a stored value (version ${existing.version}). ` +
            `Re-read it and supply If-Match: "<version>" so a concurrent edit cannot be silently overwritten.`,
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    // Fail the drift here rather than at the repository so the caller gets the
    // observed-vs-expected pair without a wasted write attempt. The repository's
    // own `updateWithVersion` remains the authoritative guard against a race
    // between this read and the update.
    if (existing.version !== expectedVersion) {
      // Same exception the repository's `updateWithVersion` raises, so the
      // global filter renders the identical 412 body (`{expectedVersion,
      // currentVersion}`) the SDK/UI conflict handler already consumes.
      throw new OptimisticConcurrencyException('GlobalSetting', existing.id, {
        expectedVersion,
        currentVersion: existing.version,
      });
    }
    const updated = await this.globalSettings.update(existing.id, { value: serialized, expectedVersion });
    return { id: updated.id, version: updated.version };
  }

  /**
   * First write. Two writers can both observe "no row", so a unique-constraint
   * failure is a LOST RACE, not an error: re-read and update instead of handing
   * the loser a 500.
   */
  private async createOrRecoverRace(
    key: string,
    descriptor: SettingDescriptor,
    serialized: string,
    valueType: ValueType,
    tenantId: string,
  ): Promise<{ id: string; version: number }> {
    try {
      const created = await this.globalSettings.create({
        name: descriptor.label ?? key,
        key,
        value: serialized,
        dataType: valueType,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId,
      });
      return { id: created.id, version: created.version };
    } catch (error) {
      const winner = await this.findBackingRow(key, tenantId);
      if (!winner) throw error;
      const updated = await this.globalSettings.update(winner.id, { value: serialized, expectedVersion: winner.version });
      return { id: updated.id, version: updated.version };
    }
  }

  // ────────────────────────────── internals ──────────────────────────────

  private getDescriptorOrThrow(key: string): SettingDescriptor {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    if (!descriptor) {
      throw new ArgumentInvalidException(`Unknown setting '${key}'.`);
    }
    return descriptor;
  }

  /**
   * Validate the incoming value against the descriptor's declared type and
   * project it onto the `GlobalSetting.value` (string) + `dataType` columns the
   * AppSettings cache parses back out.
   */
  private serialize(descriptor: SettingDescriptor, value: unknown): { serialized: string; valueType: ValueType } {
    const { key, dataType } = descriptor;

    switch (dataType satisfies SettingDataType) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a boolean (got ${typeof value}).`);
        }
        return { serialized: String(value), valueType: ValueType.Boolean };

      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new ArgumentInvalidException(`Setting '${key}' expects a number (got ${typeof value}).`);
        }
        return {
          serialized: String(value),
          valueType: Number.isInteger(value) ? ValueType.Integer : ValueType.Float,
        };
      }

      case 'string':
      case 'enum':
        if (typeof value !== 'string') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a string (got ${typeof value}).`);
        }
        return { serialized: value, valueType: ValueType.String };

      case 'string[]':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new ArgumentInvalidException(`Setting '${key}' expects an array of strings.`);
        }
        return { serialized: JSON.stringify(value), valueType: ValueType.Array };

      case 'json':
        if (value === null || typeof value !== 'object') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a JSON object.`);
        }
        return { serialized: JSON.stringify(value), valueType: ValueType.Json };

      case 'secret':
        // Unreachable — step 2 already refused secret sensitivity. Kept so the
        // switch stays exhaustive if a non-secret-sensitivity descriptor ever
        // declares a secret dataType.
        throw new ArgumentInvalidException(`Setting '${key}' is a secret and cannot be written through this lane.`);
    }
  }
}
