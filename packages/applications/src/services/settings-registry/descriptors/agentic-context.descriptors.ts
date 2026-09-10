// agentic context-management strategy descriptors.
//
// The `agentic.context.*` namespace consolidates the context-window / flush /
// claim-check knobs the live-documentation loop reads. They are GLOBAL-ADMIN-ONLY
// (the `agentic.*` privilege boundary — a privilege rule → 403, enforced at the
// service/route layer, not a cross-tenant probe), tier `global-kv`, and each
// carries its CODE DEFAULT here as the single source of truth.
//
// The consumer (`live-documentation.service.resolveAgenticContext`)
// now resolves these through `EffectiveSettingsService` on EVERY flush, so a write
// through `PUT /admin/settings/registry/:key` governs the running loop with no
// redeploy. Precedence is STORED VALUE → env override → the code default below;
// env deliberately loses to a stored value, since the registry is the control
// plane. (Previously the consumer read `env ?? default` once in its
// constructor, so these descriptors were catalog-only.)

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
  // TASK-939 R7 — minimum ms between TEXT calls for ONE session: the floor that bounds how often a
  // partial summarization can run, and therefore the cadence a clinician experiences. It was read
  // once from `LIVE_DOC_MIN_INTERVAL_MS` in the service CONSTRUCTOR, which is exactly the freeze
  // this module's own header calls out as what made the control plane decorative — the one cadence
  // knob an operator would most want to turn was the one that needed a redeploy.
  'liveFlush.minIntervalMs': 4000,
  // NOTE: `claimCheck.minBytes` was removed — the live lane never
  // consumed it; the real claim-check threshold is the harness-side
  // HARNESS_CLAIM_CHECK_MIN_BYTES env setting.
  // Transcript assembly mode. `windowed` still defaults to `whole`,
  // and its flip is measurement-gated.
  'transcript.mode': 'whole' as AgenticTranscriptMode,
  // Per-run token budget. 0 ⇒ unbounded.
  'tokenBudget.perRun': 0,
} as const;

export type AgenticContextKnobKey = keyof typeof AGENTIC_CONTEXT_DEFAULTS;

const META: Record<AgenticContextKnobKey, { dataType: SettingDescriptor['dataType']; label: string; description: string }> = {
  'liveDelta.maxChars': {
    dataType: 'number',
    label: 'Live delta max chars',
    description: 'Soft per-flush cap on the transcript delta sent to TEXT (chars).',
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
  'liveFlush.minIntervalMs': {
    dataType: 'number',
    label: 'Live flush minimum interval (ms)',
    description:
      'Floor on the time between partial-summary generations for one consultation. Raising it makes the note update less often and costs less; lowering it makes the note feel more live.',
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
  // Tuning knobs — an unset knob degrades to the code default the live loop
  // used before the registry lane existed.
  failMode: 'open-to-default',
  category: 'Agentic Context',
  label: META[knob].label,
  description: META[knob].description,
  default: AGENTIC_CONTEXT_DEFAULTS[knob],
}));
