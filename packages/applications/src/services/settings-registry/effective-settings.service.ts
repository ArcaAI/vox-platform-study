// TASK-504 Phase 3b (follow-up) — EffectiveSettingsService facade.
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

export interface EffectiveSettingResult {
  key: string;
  tier: string;
  value: unknown;
  /** Which cascade tier supplied the value (audit/debug trace). */
  sourceScope: string;
}

@Injectable()
export class EffectiveSettingsService {
  constructor(
    private readonly configResolver: ConfigResolver,
    // TASK-506 — resolver for models.* keys. Optional so graphs that never
    // read task-model defaults (and existing unit tests) keep working; an
    // unwired models.* read falls through to the no-resolver error.
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
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

    // TASK-506 — models.<taskKey> delegates to AiTaskDefaultService (tenant →
    // SYSTEM cascade); never re-implements data access here.
    if (key.startsWith('models.') && this.aiTaskDefaultService) {
      const taskKey = key.slice('models.'.length);
      const effective = await this.aiTaskDefaultService.getEffective(taskKey, ctx.tenantId);
      return { key, tier: descriptor.tier, value: effective.modelSlug, sourceScope: effective.source ?? 'none' };
    }

    throw new ArgumentInvalidException(`No effective resolver is registered for setting '${key}'.`);
  }
}
