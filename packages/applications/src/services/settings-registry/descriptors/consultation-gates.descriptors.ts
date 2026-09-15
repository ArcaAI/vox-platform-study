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
// `harness.loop.enabled` is GONE, replaced by
// `harness.loop.emergencyStop`. It was two devices wearing one key: commercial
// eligibility (now the `agenticLoop` subscription entitlement, resolved from
// the database per tenant) and an operational stop (what remains here, with the
// polarity flipped so its disarmed default and the day-1 product requirement
// finally agree). The full reasoning is next to the key itself, in
// `../../consultation/consultation-gates.constants.ts`.

import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_OCR_ENABLED_KEY,
  CONSULTATION_RECORDING_STALE_MINUTES_KEY,
  CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
  CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY,
  CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY,
  HARNESS_LOOP_EMERGENCY_STOP_KEY,
  CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY,
} from '../../consultation/consultation-gates.constants';
import { SettingDescriptor } from '../registry.types';
import { FEATURE_AVAILABILITY_CATEGORY } from './feature-availability.descriptors';

/**
 * TASK-932 R-8 — where the consultation gates that are NOT feature availability
 * went when the "Feature Flags" category was dissolved.
 *
 * The membership test for `Feature Availability` is "does this capability exist
 * for this tenant?", and these four fail it in two different ways: two are
 * platform-only pipeline STAGE gates with no tenant row to write
 * (`consultation.ocr.enabled`, `…requirePrimedBeforeRecording`), and two are
 * tuning values with no on/off semantics at all (the idle timeout and its sweep
 * cron). Filing them under an availability matrix would put four rows on a
 * screen that cannot act on any of them.
 */
export const CONSULTATION_PIPELINE_CATEGORY = 'Consultation Pipeline';

export const CONSULTATION_GATE_SETTINGS: SettingDescriptor[] = [
  // The realtime graph executor's PER-TENANT rollout flag.
  {
    key: CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    // TENANT, deliberately — see the constant's doc. The two switches below are
    // platform emergency stops (`maxScope: 'system'`, `globalOnly`); this is a
    // rollout gate, and a rollout that cannot be scoped to one tenant is not one.
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // OWNER DECISION (2026-09-05, the graphExecutor amendment to #7): a rollout
    // switch is the PLATFORM's, not the tenant's. `maxScope` stays `tenant` so a
    // super admin can still roll the executor out one tenant at a time — the two
    // fields answer different questions (WHERE a row may live vs. WHO may write
    // it), and a per-tenant rollout a tenant could switch on for itself is not a
    // rollout.
    globalOnly: true,
    failMode: 'open-to-default',
    killSwitch: true,
    // TASK-932 R-8 — the "Feature Flags" category is dissolved. This key IS a
    // feature-availability gate (does the graph executor exist for this
    // tenant?), it is `global-kv` + boolean + `maxScope: 'tenant'`, and it is
    // rolled out per tenant — so it belongs on the matrix with the rest.
    category: FEATURE_AVAILABILITY_CATEGORY,
    label: 'Realtime graph executor',
    description:
      "Routes the live-documentation flush through the GRAPH EXECUTOR — a walk over the tenant's compiled realtime lane — instead of the hardcoded sequence. Defaults OFF, so an unflagged tenant runs the legacy engine unchanged; the legacy path stays executable until trajectory parity is demonstrated on the same transcript. Set a row under ONE tenant to roll it out there first. With it ON, a tenant that has authored no consultation-palette graph still serves PLATFORM_REALTIME_LANE, which encodes the legacy sequence as a graph — so enabling it is not the same as changing what the tenant's note looks like.",
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY],
  },
  // the loop's OPERATIONAL stop. Its commercial counterpart is the
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
    // NOT `Feature Availability`, deliberately: its polarity is INVERTED
    // (true = STOP), so a checkbox column headed "available" would read
    // backwards. An operator stop for the whole deployment is platform
    // operations.
    category: 'Platform Operations',
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
    // A pipeline STAGE gate, not a product feature a tenant is entitled to:
    // it is platform-only (`maxScope: 'system'`), so it has no tenant row for
    // the availability matrix to write. Categorised with its siblings.
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Server-side OCR enrichment',
    description:
      'Enables `OcrEnrichmentProcessor` — the in-cluster PyMuPDF + RapidOCR pass that fills `ContextItem.metaData.extractedText` for scanned attachments the browser text-layer extractor could not read. Resolved on EVERY ContextAdded event, so it can be cut without a redeploy when the NLP service is under pressure. NOW DEFAULTS OFF: the `OCR_ENABLED` env flag it replaces defaulted ON, which violated the kill-switch defaults-OFF invariant — enabling OCR is now an explicit operator action. With it off, a scanned attachment degrades to its filename label exactly as a failed OCR pass already did. PHI posture is unchanged (bytes stay in-cluster, no third-party egress).',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_OCR_ENABLED_KEY],
  },
  // The session state-machine's one flagged precondition.
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
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Require PRIMED before RECORDING',
    description:
      "Enforces the session state machine's `PRIMED → RECORDING` guard on `POST :id/recording/start`. Defaults OFF: no existing SDK/admin-console caller invokes `POST :id/prime` yet, so flipping this ON without a prior client rollout would 409 every recording start. OFF logs the would-be violation and proceeds; ON enforces (409 without a prior `prime`). Deleted once `prime` is the end-to-end consent checkpoint.",
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY],
  },
  // General session-idleness timeout. A
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
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation session idle timeout (minutes)',
    description:
      'Minutes a consultation may sit in a sweep-eligible state (PRIMED, DRAINING, DRAFT_PENDING_SENSORS, TIMED_OUT, REOPENED) with no clinician activity before the scheduled sweep transitions it to CLOSED_INCOMPLETE. Documented default 1440 (24h), provisional — tune down once real abandonment-rate data exists. Consumed by `ConsultationTimeoutSweepService`.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY],
  },
  // Sweep cadence — how OFTEN
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
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation session-timeout sweep schedule',
    description:
      'Cron expression for how often `ConsultationTimeoutSweepService` checks for sweep-eligible consultations past `consultation.state.sessionTimeoutMinutes`. Default every 15 minutes.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY],
  },
  // TASK-972 Lane 8 (OD-6) — the PENDING_REVIEW leg's window. Same shape as
  // `..sessionTimeoutMinutes`: a tuning knob, not a kill-switch, so
  // `killSwitch` is intentionally omitted.
  {
    key: CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation review idle timeout (minutes)',
    description:
      'Minutes a consultation may sit in PENDING_REVIEW with no clinician activity before the scheduled sweep transitions it to TIMED_OUT. Deliberately NOT CLOSED_INCOMPLETE: TIMED_OUT is RECOVERABLE — `TIMED_OUT → SIGNED` is a legal transition and `SummaryService.approveSummary` already accepts it, so a clinician who reviews and submits hours later still signs the note, still closes the consultation, and still yields a training pair. Until this leg existed, PENDING_REVIEW was the one state nothing in the platform could clear (the general sweep excludes it; the gate-SLA escalation path only fires on a terminal harness gate abandon). Default 120 (2h). Consumed by `ConsultationTimeoutSweepService.sweepIdlePendingReview`.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY],
  },
  // TASK-972 Lane 8 (OD-7) — the OPEN leg's window. Same shape again.
  {
    key: CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation open idle timeout (minutes)',
    description:
      'Minutes a consultation may sit in OPEN — never primed, never recorded — before the scheduled sweep transitions it to CLOSED_INCOMPLETE. OPEN was structurally unclosable before TASK-972 (its only outgoing edge was OPEN → PRIMED), so an abandoned pre-recording session leaked forever. TWO signals are required, not one: the row must have been untouched for the window AND no ContextItem may have been created inside it, because adding context does not bump `Consultation.updatedAt` and this target reaches only REOPENED. Default 120 (2h), live-tunable with no redeploy. Consumed by `ConsultationTimeoutSweepService.sweepIdleOpen`.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY],
  },
  // The RECORDING leg's own staleness window (TASK-932 OD-9, N). A tuning
  // knob, not a kill-switch: no on/off semantics, so `killSwitch` is
  // intentionally omitted — same shape as `..sessionTimeoutMinutes` above.
  {
    key: CONSULTATION_RECORDING_STALE_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Recording stale timeout (minutes)',
    description:
      'Minutes a consultation may sit in RECORDING with no `consultation:live-summary:{id}:lock` key before the scheduled sweep force-stops it via `ConsultationService.stopRecording` (the same path a real client uses), landing it in DRAINING where `..sessionTimeoutMinutes` eventually takes over. Both signals are required — age AND an absent lock — so an active capture session is never interrupted. Default 30 minutes (OD-9). Consumed by `ConsultationTimeoutSweepService.sweepStaleRecordings`.',
    default: CONSULTATION_GATE_DEFAULTS[CONSULTATION_RECORDING_STALE_MINUTES_KEY],
  },
];
