/**
 * Platform limits + the pure effective-config resolver for the per-tenant STT
 * fallback/BYOK spec.
 *
 * Far leaner than the TTS resolver: STT has no routing chains or voice bindings.
 * A tenant's editable spec (fallback pipeline pointer + auto-switch knobs) is
 * layered over the SYSTEM-tenant platform default (`null` = inherit), and the
 * resolver is pure/side-effect-free so it is trivially unit-tested and the
 * gateway may call it on the session-create path.
 */

import { AiModelFormat } from '@arcaai/domains';

/** BYO providers that accept a tenant-supplied key (D-1). Local engines have no key. */
export const BYO_STT_PROVIDERS = ['azure-speech', 'sarvam', 'openai'] as const;

/**
 * Decrypted per-tenant provider credentials, injected by the gateway into
 * apps/stt (streaming) or pulled by the batch worker. snake_case matches the
 * Python wire shape (§3.3). Never persisted, never logged, never returned by a
 * read API.
 */
export type SttProviderOverrides = Record<string, { api_key: string; region?: string; base_url?: string; endpoint?: string; model?: string }>;

/** Code defaults for the fallback spec (last fallback in the cascade). */
export const STT_FALLBACK_DEFAULTS = {
  autoSwitchEnabled: true,
  // §3.4 auto-switch after N consecutive utterance failures on a threshold-class error.
  consecutiveFailureThreshold: 2,
} as const;

/**
 * Cloud STT providers (the `provider::model` shorthand prefix, lower-cased) and
 * cloud AiModel formats. A fallback pipeline must be backed by one of these —
 * a local GPU pipeline is not a meaningful outage escape (§3.2).
 */
export const CLOUD_STT_PROVIDERS: ReadonlySet<string> = new Set(['azure', 'azure-speech', 'azure-foundry', 'sarvam', 'openai']);

export const CLOUD_STT_FORMATS: ReadonlySet<string> = new Set<string>([
  AiModelFormat.AZURE_SPEECH,
  AiModelFormat.AZURE_FOUNDRY,
  AiModelFormat.CLOUD_API,
  // TASK-586: SARVAM / OPENAI are now first-class AiModelFormat members, so a
  // bare-slug fallback pipeline pointing at the Sarvam/OpenAI catalog row resolves
  // to a cloud format here exactly like Azure.
  AiModelFormat.SARVAM,
  AiModelFormat.OPENAI,
]);

/**
 * Cloud engines that are BATCH-ONLY and therefore CANNOT serve as a live
 * fallback: the runtime fallback is a mid-session streaming engine swap, so a
 * batch-only engine (e.g. Azure AI Foundry / MAI-Transcribe 1.5 — PREVIEW,
 * batch-only per TASK-505 D4) would fail at switch time. These are cloud-backed
 * but must be excluded from the fallback picker AND rejected on write, so a
 * tenant never points `fallbackPipelineId` at a target that can't stream.
 * Classified by both the `provider::model` shorthand prefix and the AiModel
 * format, matching the two resolution paths in the service.
 */
export const BATCH_ONLY_STT_PROVIDERS: ReadonlySet<string> = new Set(['azure-foundry']);

export const BATCH_ONLY_STT_FORMATS: ReadonlySet<string> = new Set<string>([AiModelFormat.AZURE_FOUNDRY]);

/** Nullable spec shape (a tenant OR the SYSTEM-default row). null = inherit. */
export interface SttSpecInput {
  fallbackPipelineId?: string | null;
  autoSwitchEnabled?: boolean | null;
  consecutiveFailureThreshold?: number | null;
}

/** Fully-resolved fallback spec — every field concrete, ready for the gateway. */
export interface EffectiveSttConfig {
  fallbackPipelineId: string | null;
  autoSwitchEnabled: boolean;
  consecutiveFailureThreshold: number;
}

/** Pick the first "set" value across tenant → system → code default. */
function pickScalar<T>(tenant: T | null | undefined, system: T | null | undefined, code: T): T {
  if (tenant !== null && tenant !== undefined) return tenant;
  if (system !== null && system !== undefined) return system;
  return code;
}

/**
 * Resolve the effective STT fallback config for a tenant: tenant row over the
 * SYSTEM default over code defaults. `fallbackPipelineId` has no code default
 * (a fallback is an explicit choice), so it resolves to `null` when unset at
 * both tiers.
 */
export function resolveEffectiveSttConfig(system: SttSpecInput | null, tenant: SttSpecInput | null): EffectiveSttConfig {
  const s = system ?? {};
  const t = tenant ?? {};
  return {
    fallbackPipelineId: pickScalar(t.fallbackPipelineId, s.fallbackPipelineId, null),
    autoSwitchEnabled: pickScalar(t.autoSwitchEnabled, s.autoSwitchEnabled, STT_FALLBACK_DEFAULTS.autoSwitchEnabled),
    consecutiveFailureThreshold: pickScalar(
      t.consecutiveFailureThreshold,
      s.consecutiveFailureThreshold,
      STT_FALLBACK_DEFAULTS.consecutiveFailureThreshold,
    ),
  };
}
