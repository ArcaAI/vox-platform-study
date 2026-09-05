// (follow-up) — EffectiveSettingsService facade.
//
// One registry-key-addressed read surface for "what is the effective value of
// setting K for this context, and which tier set it?". It delegates to the
// existing per-tier resolvers (pipeline → ConfigResolver today; extensible per
// tier) rather than re-implementing data access, and REFUSES secret-sensitivity
// keys so a secret value can never be surfaced through a config read.

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IAiTaskDefaultService } from '../ai-task-default/IAiTaskDefaultService';
import { ConfigResolutionContext, ConfigResolver, PipelineToggleKey } from '../config-resolver/config-resolver.service';
import { PlatformStorageSettingsResolver } from '../tenant-storage-config/platform-storage-settings.resolver';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import type { SettingDescriptor } from './registry.types';
import { applyDeclaredFailMode, TenantSettingsService } from './tenant-settings.service';

export interface EffectiveSettingResult {
  key: string;
  tier: string;
  value: unknown;
  /** Which cascade tier supplied the value (audit/debug trace). */
  sourceScope: string;
}

/**
 * The single place the declared failure mode is applied — called wherever a
 * cascade bottoms out with NO value.
 *
 * `closed` → raise. The caller gets an explicit "unresolved", never a
 *                     substituted value it did not ask for.
 * `open-to-default` → the descriptor default, reported as `code-default`.
 *
 * Reached ONLY when every tier came back empty. A backend error propagates
 * before this point, so a fail-open knob can never disguise an unreachable
 * control plane as "the default".
 */
export function applyFailMode(descriptor: SettingDescriptor): EffectiveSettingResult {
  // The policy itself lives in `tenant-settings.service.ts` so BOTH read
  // surfaces share one implementation; this wrapper only shapes the result.
  return { key: descriptor.key, tier: descriptor.tier, value: applyDeclaredFailMode(descriptor), sourceScope: 'code-default' };
}

/**
 * Which resolution lane a descriptor dispatches to — or `null` when NOTHING
 * can answer it.
 *
 * Exported because it is the ONE fact two very different callers need:
 * `resolveEffective` below dispatches on it, and the governance test
 * (`consumed-by-resolvability.governance.test.ts`) asserts that no descriptor
 * declaring `consumedBy` maps to `null`.
 *
 * That test is the structural half of the A.1 fix. The runtime half
 * (this branch table) makes `db-config` resolvable; the test is what stops the
 * NEXT unresolvable tier from shipping, because
 * `EffectiveConfigService.resolveKey` cannot tell a permanently-missing
 * resolver from a transient outage — it degrades to `null` for both, which is
 * exactly how a key could be declared, deployed, and silently dead.
 */
export function effectiveResolverLane(descriptor: SettingDescriptor): string | null {
  const { key, tier } = descriptor;
  if (key.startsWith('pipeline.')) return 'pipeline';
  if (key.startsWith('models.')) return 'models';
  if (tier === 'global-kv') return 'global-kv';
  // `db-config` is per-FAMILY, not per-tier: each family is owned by the
  // service that owns its table, so opening the tier wholesale would be a lie.
  if (tier === 'db-config' && PLATFORM_STORAGE_KEYS.has(key)) return 'db-config:platform-storage';
  return null;
}

/**
 * The `db-config` keys the platform-storage lane answers. Duplicated from the
 * resolver's own table ON PURPOSE: `effectiveResolverLane` is a pure static
 * predicate a test can call with no DI graph, while the resolver needs a
 * repository. `platform-storage-settings.resolver.test.ts` pins the resolver's
 * side and the governance test pins this side, so a divergence fails loudly.
 */
const PLATFORM_STORAGE_KEYS = new Set([
  'storage.platformDefault.provider',
  'storage.platformDefault.endpoint',
  'storage.platformDefault.region',
  'storage.platformDefault.forcePathStyle',
  'storage.platformDefault.containerPrefix',
]);

@Injectable()
export class EffectiveSettingsService {
  constructor(
    private readonly configResolver: ConfigResolver,
    // Resolver for models.* keys. Optional so graphs that never
    // read task-model defaults (and existing unit tests) keep working; an
    // unwired models.* read falls through to the no-resolver error.
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // Backs the `global-kv` lane. Optional so graphs that never read KV
    // settings (and existing unit tests) keep working; an unwired resolver
    // simply falls back to the descriptor default.
    //
    // This used to be `IAppSettingsService` read directly with
    // a key-only lookup, which could only ever answer with the PLATFORM value.
    // Now that six knobs are `maxScope: 'tenant'`, the facade must answer for
    // the CALLER'S tenant or it would report a value that is not the one the
    // consumer will actually enforce.
    @Optional() private readonly tenantSettings?: TenantSettingsService,
    // Backs the `db-config` lane for `storage.platformDefault.*`. Optional for
    // the same reason as the two above: a graph that never reads storage config
    // (and the existing unit tests) must keep working, and an unwired resolver
    // falls through to the DECLARED failure mode rather than to a DI error.
    @Optional() private readonly platformStorage?: PlatformStorageSettingsResolver,
  ) {}

  /**
   * Resolve a registry setting's effective value for a consultation context.
   * Throws `ArgumentInvalidException` (→ 400) for an unknown key, a secret key,
   * or a key with no registered effective resolver.
   */
  async resolveEffective(key: string, ctx: ConfigResolutionContext): Promise<EffectiveSettingResult> {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
    if (descriptor.sensitivity === 'secret') {
      throw new ArgumentInvalidException(`Setting '${key}' is a secret; effective values are never resolved through this read surface.`);
    }

    if (key.startsWith('pipeline.')) {
      const toggle = key.slice('pipeline.'.length) as PipelineToggleKey;
      const resolved = await this.configResolver.resolvePipelineToggles(ctx);
      if (!(toggle in resolved.trace)) {
        throw new ArgumentInvalidException(`Unknown pipeline setting '${key}'.`);
      }
      return { key, tier: descriptor.tier, value: resolved[toggle], sourceScope: resolved.trace[toggle] };
    }

    // Models.<taskKey> delegates to AiTaskDefaultService (tenant →
    // SYSTEM cascade); never re-implements data access here.
    //
    // An UNSELECTED task (`modelSlug` null) is an unresolved value, so it goes
    // through the declared failure mode. Every `models.*` descriptor is
    // fail-closed, so this raises rather than reporting a null that a caller
    // cannot distinguish from a deliberately-null selection.
    if (key.startsWith('models.') && this.aiTaskDefaultService) {
      const taskKey = key.slice('models.'.length);
      const effective = await this.aiTaskDefaultService.getEffective(taskKey, ctx.tenantId);
      if (effective.modelSlug === null || effective.modelSlug === undefined) {
        return applyFailMode(descriptor);
      }
      return { key, tier: descriptor.tier, value: effective.modelSlug, sourceScope: effective.source ?? 'none' };
    }

    // The `global-kv` lane — the full cascade:
    //
    //   tenant override → SYSTEM/platform row → descriptor.default
    //   sourceScope: 'tenant' → 'system' → 'code-default'
    //
    // The reported `sourceScope` is the tier that actually answered, so a
    // caller can see WHY a value is what it is. `ctx.tenantId` is the
    // tenant the caller is asking about — for a tenant admin that is its own
    // tenant, for a super admin the working tenant resolved by the controller.
    if (descriptor.tier === 'global-kv') {
      if (!this.tenantSettings) return applyFailMode(descriptor);
      const resolved = this.tenantSettings.resolve(key, ctx.tenantId ?? null);
      return { key, tier: descriptor.tier, value: resolved.value, sourceScope: resolved.source };
    }

    // The `db-config` lane.
    //
    // Dispatched per key FAMILY to the service that owns that family's table —
    // never resolved here. `AiTaskDefault` (`models.*`) and `PipelinePolicy`
    // (`pipeline.*`) are handled above; `TenantStorageConfig` is handled below.
    // Families whose values vary BY TENANT (`tts.defaultVoiceEn`) deliberately
    // have no lane: per owner decision D-1 they
    // travel the PUSH channel — per-request gateway injection — and putting
    // them on this PLATFORM-scope read would serve one tenant's value to all.
    //
    // Note what does NOT change: the declared `failMode` is applied only when a
    // cascade bottoms out with no value, and a backend ERROR propagates from
    // the owning resolver untouched. A fail-open knob must never be able to
    // disguise an unreachable control plane as "the default".
    if (descriptor.tier === 'db-config' && this.platformStorage?.resolves(key)) {
      const resolved = await this.platformStorage.resolve(key);
      if (!resolved) return applyFailMode(descriptor);
      return { key, tier: descriptor.tier, value: resolved.value, sourceScope: resolved.sourceScope };
    }

    // An unwired graph is NOT a defect — it is a composition that never reads
    // this family (see the constructor). Falling through to the declared
    // failure mode keeps such a graph on the descriptor default instead of
    // turning a missing optional dependency into a 400.
    if (descriptor.tier === 'db-config' && !this.platformStorage && PLATFORM_STORAGE_KEYS.has(key)) {
      return applyFailMode(descriptor);
    }

    throw new ArgumentInvalidException(`No effective resolver is registered for setting '${key}'.`);
  }
}
