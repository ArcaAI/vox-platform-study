// Consultation-pipeline kill-switches — MIGRATED from env to `global-kv`.
//
// Two `@OnEvent(ContextAdded)` gates that were plain `process.env` flags read
// once in a constructor. The rationale, the polarity rule and the deliberate
// ABSENCE of an env bootstrap fallback are all recorded next to the keys
// themselves, in `../../consultation/consultation-gates.constants.ts` — this
// file adds only the classification metadata.
//
// `tier: 'global-kv'` is the honest present-tense answer (the honesty rule of
// `platform-knobs.descriptors.ts`): the READER moved in the same commit, so
// there is no `targetTier` to record.
//
// ⚠️ BEHAVIOUR CHANGE, deliberate and mandated — `consultation.ocr.enabled`.
// `OCR_ENABLED` DEFAULTED TO ENABLED (`ocr-enrichment.processor.ts` treated
// unset as on, and only an explicit falsey string disabled it). A kill-switch
// MUST default OFF, so the migrated key defaults `false` and server-side OCR
// enrichment is now OPT-IN.
//
// TASK-705 — `harness.loop.enabled` is GONE, replaced by
// `harness.loop.emergencyStop`. It was two devices wearing one key: commercial
// eligibility (now the `agenticLoop` subscription entitlement, resolved from
// the database per tenant) and an operational stop (what remains here, with the
// polarity flipped so its disarmed default and the day-1 product requirement
// finally agree). The full reasoning is next to the key itself, in
// `../../consultation/consultation-gates.constants.ts`.

import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_OCR_ENABLED_KEY,
  CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
  HARNESS_LOOP_EMERGENCY_STOP_KEY,
} from '../../consultation/consultation-gates.constants';
import { SettingDescriptor } from '../registry.types';

export const CONSULTATION_GATE_SETTINGS: SettingDescriptor[] = [
  // TASK-705 — the loop's OPERATIONAL stop. Its commercial counterpart is the
  // `agenticLoop` subscription entitlement, which is not a setting at all.
  {
    key: HARNESS_LOOP_EMERGENCY_STOP_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    // Platform-only, and load-bearing: this is the operator's stop for the whole
    // DEPLOYMENT. Per-TENANT loop eligibility is the subscription entitlement
    // (`ResolvedFeatures.agenticLoop`), and per-consultation loop POLICY is
    // `ILoopConfigService` — neither is a cascade level of this switch, which is
    // why a row planted under a tenant must never govern it.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    killSwitch: true,
    category: 'Feature Flags',
    label: 'Consultation loop emergency stop',
    description:
      'PLATFORM-WIDE EMERGENCY STOP for the harness agentic loop. Set it to true to halt `LoopContextSignalService` — the ContextAdded / consultation-ending / loop-cancel signals sent to `ConsultationLoopWorkflow` in apps/harness — for every tenant at once, with no redeploy; it is resolved on EVERY signal. Defaults OFF, meaning NO emergency in progress: a tenant whose subscription plan includes the loop (`agenticLoop` entitlement) runs it. This switch can only ever SUBTRACT — disengaging it never grants the loop to a tenant whose plan does not include it. Replaces `harness.loop.enabled`, which conflated commercial eligibility with an operational stop and consequently shipped a code default (false) that disagreed with its own seeded row (true).',
    default: CONSULTATION_GATE_DEFAULTS[HARNESS_LOOP_EMERGENCY_STOP_KEY],
  },
  {
    key: CONSULTATION_OCR_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    killSwitch: true,
    category: 'Feature Flags',
    label: 'Server-side OCR enrichment',
    description:
      'Enables `OcrEnrichmentProcessor` — the in-cluster PyMuPDF + RapidOCR pass that fills `ContextItem.metaData.extractedText` for scanned attachments the browser text-layer extractor could not read. Resolved on EVERY ContextAdded event, so it can be cut without a redeploy when the NLP service is under pressure. NOW DEFAULTS OFF: the `OCR_ENABLED` env flag it replaces defaulted ON, which violated the kill-switch defaults-OFF invariant — enabling OCR is now an explicit operator action. With it off, a scanned attachment degrades to its filename label exactly as a failed OCR pass already did. PHI posture is unchanged (bytes stay in-cluster, no third-party egress).',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_OCR_ENABLED_KEY],
  },
  // TASK-711 (Task 9) — the session state-machine's one flagged precondition.
  {
    key: CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    killSwitch: true,
    category: 'Feature Flags',
    label: 'Require PRIMED before RECORDING',
    description:
      "Enforces `docs/implementation/TASK-711-Session-State-Machine/state-machine.md` §2's `PRIMED → RECORDING` guard on `POST :id/recording/start`. Defaults OFF: no existing SDK/admin-console caller invokes `POST :id/prime` yet, so flipping this ON without a prior client rollout would 409 every recording start. OFF logs the would-be violation and proceeds; ON enforces (409 without a prior `prime`). Deleted once TASK-712 makes `prime` the end-to-end consent checkpoint.",
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY],
  },
  // TASK-711 (state-machine.md §1a) — general session-idleness timeout. A
  // tuning knob, not a kill-switch: no on/off semantics, so `killSwitch` is
  // intentionally omitted.
  {
    key: CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Feature Flags',
    label: 'Consultation session idle timeout (minutes)',
    description:
      'Minutes a consultation may sit in a sweep-eligible state (PRIMED, DRAINING, DRAFT_PENDING_SENSORS, TIMED_OUT, REOPENED) with no clinician activity before the scheduled sweep transitions it to CLOSED_INCOMPLETE (state-machine.md §1a). Documented default 1440 (24h), provisional — tune down once real abandonment-rate data exists. Consumed by `ConsultationTimeoutSweepService`.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY],
  },
  // TASK-711 (state-machine.md §1a mechanism) — how OFTEN
  // `ConsultationTimeoutSweepService` ticks. A tuning knob, not a kill-switch
  // (no `enabled` gate — the sweep runs unconditionally once the module is
  // wired, matching the "ship complete, not flag-gated" pre-production
  // posture; unlike `audit-retention.enabled`/`agentic.trajectory.enabled`
  // this worker performs a reversible-in-intent clinical status transition,
  // not a hard delete, so there is no destructive action to gate behind an
  // opt-in).
  {
    key: CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Feature Flags',
    label: 'Consultation session-timeout sweep schedule',
    description:
      'Cron expression for how often `ConsultationTimeoutSweepService` checks for sweep-eligible consultations past `consultation.state.sessionTimeoutMinutes`. Default every 15 minutes.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY],
  },
];
