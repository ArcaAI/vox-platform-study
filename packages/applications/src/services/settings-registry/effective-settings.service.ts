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
 * `closed`          → raise. The caller gets an explicit "unresolved", never a
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
    //   tenant override  →  SYSTEM/platform row  →  descriptor.default
    //   sourceScope:  'tenant'  →  'system'  →  'code-default'
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

    throw new ArgumentInvalidException(`No effective resolver is registered for setting '${key}'.`);
  }
}
