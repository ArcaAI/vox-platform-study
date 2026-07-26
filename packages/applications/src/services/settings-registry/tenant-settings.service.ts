// The `global-kv` cascade — TASK-558 lane I (plan §9.3 M1/M2/M4, §9.2 L8).
//
// WHAT THIS IS FOR. Waves 1–3 classified every key; lane I moves the values.
// Ten operational knobs and the flags that had no home but `process.env` now
// live in `GlobalSetting`, and the ones a plan tier differentiates resolve
// PER TENANT. This service is the one place that walk happens:
//
//     tenant override  →  SYSTEM/platform row  →  descriptor default
//
// THREE PROPERTIES THAT ARE NOT NEGOTIABLE
//
//  • §9.3 M4 — the tenant lane is a `${tenantId}::${key}` map inside
//    `AppSettingsService`. The key-only map stays platform-only (lane G's
//    fix); this service never mixes them, and a tenant lookup has no slot it
//    could collide with another tenant's row in.
//
//  • §9.3 M2 — entitlements are a CEILING, not a cascade level. The caller
//    passes the tenant's plan bound; `clampTenantSetting` applies it (plus the
//    monotone platform bound) to the TENANT value only. The platform value is
//    never clamped: a ceiling bounds what a tenant may SET, it does not lower
//    what the platform already decided.
//
//  • §9.3 M1 — the scope clamp is honoured on READ, not only on write. A key
//    declared `maxScope: 'system'` skips the tenant lane entirely, so a row
//    planted under a tenant (by a future bug, a bad migration, or the legacy
//    `GlobalSettingController` CRUD over the same table) can never govern a
//    setting a tenant is not allowed to set.
//
// SYNCHRONOUS ON PURPOSE. Both accessors read the in-memory cache and do no
// I/O, because the first consumer is `TieredThrottlerGuard` — a per-request hot
// path. Propagation is push, not poll: a registry write refreshes the cache and
// publishes on `app-settings:invalidate`, which lane G proved end to end, so
// both lanes converge without a TTL wait (§9.2 L4).

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import type { SettingDescriptor } from './registry.types';
import { clampTenantSetting } from './tenant-clamp';

/** Which tier of the cascade supplied the value (§9.2 L8 — every fallback is observable). */
export type SettingSourceScope = 'tenant' | 'system' | 'code-default';

export interface ResolvedTenantSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSourceScope;
  /** Present only when the tenant's stored value was narrowed by a bound. */
  clampedBy?: 'platform' | 'entitlement';
}

export interface ResolveTenantSettingOptions {
  /**
   * The tenant's plan ceiling for this key, when the key has a plan analogue.
   * `null`/omitted = unlimited (ungated / null-plan tenants, Q3). Supplied by
   * the caller because entitlement resolution already happens there — pulling
   * `IEntitlementsService` in here would put a second, avoidable module edge
   * on the throttler hot path.
   */
  entitlement?: number | null;
}

/**
 * Apply the DECLARED failure mode when every tier came back empty
 * (plan §4 B3, §9.3 M5).
 *
 * `closed`          → raise; no default is substituted (secrets and
 *                     provider/model SELECTION never fall back).
 * `open-to-default` → the descriptor default.
 *
 * Reached ONLY when the cascade bottoms out with no value. A backend error
 * propagates before this point, so a fail-open knob can never disguise an
 * unreachable control plane as "the default".
 *
 * Lives here (rather than in `effective-settings.service.ts`, where it was
 * introduced) so both read surfaces share ONE implementation without an import
 * cycle: `effective-settings` imports this module, never the reverse.
 */
export function applyDeclaredFailMode(descriptor: SettingDescriptor): unknown {
  if (descriptor.failMode === 'closed') {
    throw new ArgumentInvalidException(
      `Setting '${descriptor.key}' could not be resolved and is declared fail-closed; ` +
        'no default is substituted (provider/model selection and secrets never fall back).',
    );
  }
  return descriptor.default;
}

@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  /** Keys already WARN-logged for a clamp, so a hot path logs once, not per request. */
  private readonly warnedClamps = new Set<string>();

  constructor(@Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService) {}

  /**
   * The platform lane only: SYSTEM/GLOBAL row → descriptor default.
   * Use for `maxScope: 'system'` keys and for any caller with no tenant in
   * context (the throttler before a token is decoded, a boot-time reader).
   */
  resolvePlatform<T = unknown>(key: string): ResolvedTenantSetting<T> {
    return this.resolve<T>(key, null);
  }

  /**
   * The full cascade for `key` as seen by `tenantId`.
   *
   * `tenantId === null` resolves the platform lane. A key whose `maxScope` is
   * shallower than `tenant` never consults the tenant lane at all.
   */
  resolve<T = unknown>(key: string, tenantId: string | null, options: ResolveTenantSettingOptions = {}): ResolvedTenantSetting<T> {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    if (!descriptor) {
      throw new ArgumentInvalidException(`Unknown setting '${key}'.`);
    }
    // Same refusal as the write lane and `EffectiveSettingsService`: a secret
    // value never traverses a config read surface.
    if (descriptor.sensitivity === 'secret') {
      throw new ArgumentInvalidException(`Setting '${key}' is a secret; effective values are never resolved through this read surface.`);
    }

    const platform = this.appSettings.getValueFromCache(key);

    // The tenant lane — gated on the DECLARED max scope (§9.3 M1), so the read
    // path enforces the same clamp the write path does.
    if (tenantId && descriptor.maxScope !== 'system') {
      const stored = this.appSettings.getTenantValueFromCache(tenantId, key);
      if (stored !== null && stored !== undefined) {
        const clamp = clampTenantSetting(key, stored, {
          // The platform bound is the resolved platform lane: the row if one
          // exists, otherwise the descriptor default. Falling straight through
          // to `undefined` would leave a tenant unbounded on a fresh database.
          platform: platform !== null && platform !== undefined ? platform : descriptor.default,
          ...(options.entitlement === undefined ? {} : { entitlement: options.entitlement }),
        });
        if (clamp.clamped) {
          this.warnOnce(key, tenantId, stored, clamp.value, clamp.bound);
          return { key, value: clamp.value as T, source: 'tenant', clampedBy: clamp.bound };
        }
        return { key, value: stored as T, source: 'tenant' };
      }
    }

    if (platform !== null && platform !== undefined) {
      return { key, value: platform as T, source: 'system' };
    }

    return { key, value: applyDeclaredFailMode(descriptor) as T, source: 'code-default' };
  }

  /**
   * §9.2 L8 — a narrowed value must be observable, or an admin sees their
   * setting "not take effect" with no explanation. Logged once per
   * (key, tenant) so a per-request resolution cannot flood the log.
   */
  private warnOnce(key: string, tenantId: string, requested: unknown, applied: unknown, bound?: string): void {
    const marker = `${tenantId}::${key}`;
    if (this.warnedClamps.has(marker)) return;
    this.warnedClamps.add(marker);
    this.logger.warn({
      message: 'Tenant setting override clamped',
      settingKey: key,
      tenantId,
      requested,
      applied,
      bound,
    });
  }
}
