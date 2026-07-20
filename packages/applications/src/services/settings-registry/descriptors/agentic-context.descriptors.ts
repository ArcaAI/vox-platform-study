// agentic context-management strategy descriptors.
//
// The `agentic.context.*` namespace consolidates the context-window / flush /
// claim-check knobs the live-documentation loop reads. They are GLOBAL-ADMIN-ONLY
// (the `agentic.*` privilege boundary — a privilege rule → 403, enforced at the
// service/route layer, not a cross-tenant probe), tier `global-kv`, and each
// carries its CODE DEFAULT here as the single source of truth.
//
// TASK-533 B1 — the consumer (`live-documentation.service.resolveAgenticContext`)
// now resolves these through `EffectiveSettingsService` on EVERY flush, so a write
// through `PUT /admin/settings/registry/:key` governs the running loop with no
// redeploy. Precedence is STORED VALUE → env override → the code default below;
// env deliberately loses to a stored value, since the registry is the control
// plane. (Before B1 the consumer read `env ?? default` once in its constructor, so
// these descriptors were catalog-only — D-19/GAP-C7.)

import { SettingDescriptor } from '../registry.types';

/** Canonical transcript-assembly mode. */
export type AgenticTranscriptMode = 'whole' | 'windowed';

/**
 * The agentic context knob keys (dotted, WITHOUT the `agentic.context.` prefix)
 * mapped to their code defaults — the single source of truth shared by the
 * registry descriptors and the live-documentation consumer.
 */
export const AGENTIC_CONTEXT_DEFAULTS = {
  // Soft per-flush transcript-delta cap (chars). Was `MAX_DELTA_CHARS = 12000`.
  'liveDelta.maxChars': 12000,
  // Final-segment count that triggers an incremental flush.
  'liveFlush.segmentThreshold': 3,
  // Idle debounce (ms) before a flush when the segment threshold is not met.
  'liveFlush.idleMs': 5000,
  // Payloads at/above this size (bytes) are stored/passed by reference
  // (claim-check) rather than inlined. Resolved by the live lane (TASK-533 B1);
  // the harness-side claim-check threshold is its own HARNESS_CLAIM_CHECK_MIN_BYTES.
  'claimCheck.minBytes': 65536,
  // Transcript assembly mode. `windowed` is TASK-533 B3 — still default `whole`,
  // and its flip is measurement-gated.
  'transcript.mode': 'whole' as AgenticTranscriptMode,
  // Per-run token budget. 0 ⇒ unbounded. Enforcement is TASK-533 B4.
  'tokenBudget.perRun': 0,
} as const;

export type AgenticContextKnobKey = keyof typeof AGENTIC_CONTEXT_DEFAULTS;

const META: Record<AgenticContextKnobKey, { dataType: SettingDescriptor['dataType']; label: string; description: string }> = {
  'liveDelta.maxChars': {
    dataType: 'number',
    label: 'Live delta max chars',
    description: 'Soft per-flush cap on the transcript delta sent to SMR (chars).',
  },
  'liveFlush.segmentThreshold': {
    dataType: 'number',
    label: 'Live flush segment threshold',
    description: 'Number of final transcript segments that triggers an incremental flush.',
  },
  'liveFlush.idleMs': {
    dataType: 'number',
    label: 'Live flush idle debounce (ms)',
    description: 'Idle time before a flush when the segment threshold is not yet met.',
  },
  'claimCheck.minBytes': {
    dataType: 'number',
    label: 'Claim-check min bytes',
    description: 'Payloads at/above this size are passed by reference (claim-check) rather than inlined.',
  },
  'transcript.mode': {
    dataType: 'enum',
    label: 'Transcript mode',
    description: 'Transcript assembly strategy: whole (default) or windowed.',
  },
  'tokenBudget.perRun': {
    dataType: 'number',
    label: 'Token budget per run',
    description: 'Per-run token budget. 0 = unbounded.',
  },
};

export const AGENTIC_CONTEXT_KEY_PREFIX = 'agentic.context.';

export const AGENTIC_CONTEXT_SETTINGS: SettingDescriptor[] = (
  Object.keys(AGENTIC_CONTEXT_DEFAULTS) as AgenticContextKnobKey[]
).map<SettingDescriptor>((knob) => ({
  key: `${AGENTIC_CONTEXT_KEY_PREFIX}${knob}`,
  tier: 'global-kv',
  dataType: META[knob].dataType,
  sensitivity: 'internal',
  // agentic.* is GLOBAL-ADMIN-only — platform-owned, not tenant-set.
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  category: 'Agentic Context',
  label: META[knob].label,
  description: META[knob].description,
  default: AGENTIC_CONTEXT_DEFAULTS[knob],
}));
