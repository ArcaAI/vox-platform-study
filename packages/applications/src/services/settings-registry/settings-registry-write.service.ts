import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ResourceType, SysEventType, ValueType } from '@arcaai/domains';
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
}

export interface WriteRegistrySettingResult {
  key: string;
  tier: string;
  value: unknown;
  scope: SettingScope;
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

    // 7. Upsert the backing row + refresh the cache the consumers read.
    const cached = this.appSettings.getFromCache(key);
    if (cached) {
      await this.globalSettings.update(cached.id, { value: serialized, expectedVersion: cached.version });
    } else {
      await this.globalSettings.create({
        name: descriptor.label ?? key,
        key,
        value: serialized,
        dataType: valueType,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId: GLOBAL_TENANT_ID,
      });
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: cached?.id ?? key,
      data: { key, scope, tier: descriptor.tier, namespace: REGISTRY_SETTING_NAMESPACE },
    });

    await this.appSettings.refreshCache();

    return { key, tier: descriptor.tier, value, scope };
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
