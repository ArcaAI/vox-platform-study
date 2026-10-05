// agentic eval-gate descriptors.
//
// `agentic.eval.promotionGate` governs the mandatory (OD-3) eval gate that runs
// when a template version is APPROVED — or a DepartmentAgent's pinned version is
// re-pointed — and the agent references a golden set:
//
//   'block' (default) — a failing eval BLOCKS the promotion (409 + score payload).
//   'warn'            — the eval runs + is recorded, but a failure does NOT block.
//   'off'             — the gate is skipped entirely (no eval run).
//
// It is GLOBAL-ADMIN-ONLY (the `agentic.*` privilege boundary — a privilege rule
// → 403, enforced at the service layer, not a cross-tenant probe), tier
// `global-kv`, and carries its code default here as the single source of truth.
// Resolved through `EffectiveSettingsService.resolveEffective` (global-kv lane),
// so a write via `PUT /admin/settings/registry/:key` governs the gate with no
// redeploy.

import { SettingDescriptor } from '../registry.types';

/** The operational escape-hatch modes for the eval promotion gate. */
export type EvalPromotionGateMode = 'block' | 'warn' | 'off';

export const AGENTIC_EVAL_PROMOTION_GATE_KEY = 'agentic.eval.promotionGate';

/** Code default — mandatory blocking per OD-3. Governs template APPROVAL and prompt PIN re-point. */
export const AGENTIC_EVAL_PROMOTION_GATE_DEFAULT: EvalPromotionGateMode = 'block';

/**
 * TASK-885 / owner #7 — the PATH-SCOPED default for WORKFLOW promotion (Global → SYSTEM).
 *
 * The owner's decision, in substance: *the eval promotion gate must not block the Global → SYSTEM
 * path on evaluation evidence that does not exist yet — relax it to `warn` by default for that
 * path while keeping `block` available.*
 *
 * Three things about the shape of that change, each deliberate:
 *
 * 1. **Same key, second default — not a second key.** A new registry key would need its own owner
 *    decision and would move the program's key count; a path-scoped default expresses exactly
 *    what was asked and nothing more. `EvalPromotionGateService.evaluateWorkflowPromotion` uses
 *    this value ONLY when nobody has written `agentic.eval.promotionGate` (the resolver reports
 *    `sourceScope: 'code-default'`). A written value wins on both paths, so `block` stays
 *    available exactly as the owner required.
 * 2. **The template-approval default is UNCHANGED.** Owner #7 relaxed the workflow-promotion
 *    path. Approval is the OD-3 clinical control on a prompt that will generate clinical text,
 *    and lowering it would be a safety regression nobody asked for.
 * 3. **Relaxing this path is not "no gate".** The eval still RUNS and is still recorded; a
 *    failure is reported as a warning on the promotion response instead of a 409. And what the
 *    promotion produces is a SYSTEM template — it does not re-point any tenant's live traffic by
 *    itself.
 */
export const AGENTIC_EVAL_WORKFLOW_PROMOTION_GATE_DEFAULT: EvalPromotionGateMode = 'warn';

// The note-completeness gate (mode `note_completeness`, the multi-encounter golden set): the
// thresholds the harness applies to critical-fact recall, dose accuracy, the unsupported-statement
// rate and p95 stop→note latency. Platform tuning — global-kv, SYSTEM only, open-to-default — and
// read by `EvalRunService` on every run, so the harness never holds a threshold of its own.

export const AGENTIC_EVAL_NOTE_RECALL_MIN_KEY = 'agentic.eval.noteCompleteness.criticalFactRecallMin';
export const AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY = 'agentic.eval.noteCompleteness.doseAccuracyMin';
export const AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY = 'agentic.eval.noteCompleteness.unsupportedRateMax';
export const AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY = 'agentic.eval.noteCompleteness.latencyP95MaxMs';

/** The descriptor defaults below, one per key (the owner targets: nothing lost, ≤ 2 % unsupported). */
export const AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS = {
  criticalFactRecallMin: 1,
  doseAccuracyMin: 1,
  unsupportedRateMax: 0.02,
  /** `0` records the p95 without gating it — no latency target has been set yet. */
  latencyP95MaxMs: 0,
} as const;

function fraction(label: string) {
  return (value: unknown): string | void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return `${label} must be a number between 0 and 1.`;
    }
  };
}

function nonNegativeMs(label: string) {
  return (value: unknown): string | void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
      return `${label} must be a whole number of milliseconds between 0 and 3600000.`;
    }
  };
}

const NOTE_COMPLETENESS = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Agentic Eval',
  dataType: 'number',
} as const;

export const AGENTIC_EVAL_SETTINGS: SettingDescriptor[] = [
  {
    key: AGENTIC_EVAL_PROMOTION_GATE_KEY,
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    // agentic.* is GLOBAL-ADMIN-only — platform-owned, not tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Mode knob — an unset gate degrades to the code default (`block`), which is
    // the SAFE end of this knob, so open-to-default does not weaken the gate.
    failMode: 'open-to-default',
    category: 'Agentic Eval',
    label: 'Eval promotion gate',
    description:
      'Governs the eval gate on template approval / agent pin re-point: block (fail → 409), warn (record only), or off. ' +
      'Unset, the Global → SYSTEM workflow-promotion path resolves `warn` instead (TASK-885 / owner #7); any value written ' +
      'here governs BOTH paths.',
    default: AGENTIC_EVAL_PROMOTION_GATE_DEFAULT,
  },
  {
    ...NOTE_COMPLETENESS,
    key: AGENTIC_EVAL_NOTE_RECALL_MIN_KEY,
    label: 'Note completeness: minimum critical-fact recall',
    description:
      'Share of the golden cases’ critical facts (medicines with dose, allergies, diagnoses, plan and orders, follow-up, red flags, negations) the generated note must state. Default 1 — nothing may be lost.',
    default: AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS.criticalFactRecallMin,
    validate: fraction('Minimum critical-fact recall'),
  },
  {
    ...NOTE_COMPLETENESS,
    key: AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY,
    label: 'Note completeness: minimum dose accuracy',
    description: 'Share of medication facts whose current dose (number and unit) the note states beside the drug. Default 1.',
    default: AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS.doseAccuracyMin,
    validate: fraction('Minimum dose accuracy'),
  },
  {
    ...NOTE_COMPLETENESS,
    key: AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY,
    label: 'Note completeness: maximum unsupported-statement rate',
    description: 'Highest share of the note’s numbers and citations that its cited sources do not support. Default 0.02.',
    default: AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS.unsupportedRateMax,
    validate: fraction('Maximum unsupported-statement rate'),
  },
  {
    ...NOTE_COMPLETENESS,
    key: AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY,
    label: 'Note completeness: maximum p95 stop-to-note latency (ms)',
    description: 'Highest p95 time from Stop to the finished note across the golden cases. 0 records the p95 without gating it. Default 0.',
    default: AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS.latencyP95MaxMs,
    validate: nonNegativeMs('Maximum p95 stop-to-note latency'),
  },
];
