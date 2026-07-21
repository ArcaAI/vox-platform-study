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

export interface WriteRegistrySettingOptions {
  /** Scope the value is being set at. Defaults to `system` for global-kv keys. */
  scope?: SettingScope;
  /**
   * TASK-533 B2 — the row version the caller last observed, folded from
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
   * TASK-533 B2 — the row version AFTER this write. Echoed so the caller can use
   * it as the next `If-Match`, and so the `ETagInterceptor` renders an ETag on
   * this response (it keys off a top-level positive-integer `version`).
   */
  version: number;
}

/**
 * TASK-524 — the settings WRITE LANE (AD-1: a single enforcement point).
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
    // TASK-533 B2 — direct repository access for a FRESH row read. The CAS
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
    const existing = await this.findBackingRow(key);
    const persisted = existing
      ? await this.updateExisting(existing, serialized, options.expectedVersion, key)
      : await this.createOrRecoverRace(key, descriptor, serialized, valueType);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: persisted.id,
      data: { key, scope, tier: descriptor.tier, namespace: REGISTRY_SETTING_NAMESPACE, newVersion: persisted.version },
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
  async getBackingRowVersion(key: string): Promise<number> {
    const row = await this.findBackingRow(key);
    return row?.version ?? 0;
  }

  /** The backing KV row for `key`, read FRESH (never the AppSettings snapshot). */
  private async findBackingRow(key: string): Promise<{ id: string; version: number } | null> {
    // `Repository.findFirst` THROWS `DataNotFoundException` on no match (it
    // never returns null) — on a fresh DB with no registry rows that exception
    // used to escape as a blanket 404 on every `GET registry/:key` (TASK-534
    // e2e G5). "No backing row yet" is a normal state here (code-default /
    // first write), so it maps to null, not an error.
    try {
      const row = await this.globalSettingRepository.findFirst({
        where: { key, namespace: REGISTRY_SETTING_NAMESPACE },
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
  ): Promise<{ id: string; version: number }> {
    try {
      const created = await this.globalSettings.create({
        name: descriptor.label ?? key,
        key,
        value: serialized,
        dataType: valueType,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId: GLOBAL_TENANT_ID,
      });
      return { id: created.id, version: created.version };
    } catch (error) {
      const winner = await this.findBackingRow(key);
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
