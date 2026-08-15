// Consultation-loop LIFECYCLE bound — `global-kv`.
//
// One knob, deliberately in its own file rather than appended to
// `consultation-gates.descriptors.ts`: that file is the two consultation-pipeline
// KILL-SWITCHES, and its whole preamble is about kill-switch polarity and the
// defaults-OFF invariant. This is a tuning knob with a non-trivial default, so
// filing it there would make both documents lie a little.
//
// The rationale, the tier argument and the "pinned, not live" property are
// recorded next to the key itself, in `../../consultation/loop/loop-lifecycle.constants.ts`
// — this file adds only the classification metadata.
//
// `tier: 'global-kv'` is the honest present-tense answer (the honesty rule of
// `platform-knobs.descriptors.ts`): the READER lands in the same commit, so
// there is no `targetTier` to record and no env fallback to keep.

import { HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT, HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY } from '../../consultation/loop/loop-lifecycle.constants';
import { SettingDescriptor } from '../registry.types';

export const HARNESS_LOOP_SETTINGS: SettingDescriptor[] = [
  {
    key: HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Platform-only, matching `harness.loop.enabled`. Per-consultation loop
    // POLICY is `ILoopConfigService`'s concern, not a cascade level of this
    // bound; a per-department bound would be a `db-config` row, not a wider
    // scope on this key.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // A tuning knob, not a selection: an absent row must degrade to the code
    // default (a bounded loop), never raise. Failing closed here would take out
    // the loop config resolution for a value whose absence has an obviously
    // correct answer.
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Consultation loop idle timeout (seconds)',
    description:
      'How long `ConsultationLoopWorkflow` may sit with NO context item, no `consultation-ending` and no `loop-cancel` before it abandons the run. Every arriving context item restarts the bound, so this measures SILENCE, not consultation length. On expiry the loop terminates in its own `TIMED_OUT` phase and publishes a `loop.timed_out` event; it deliberately does NOT run the ending actions, because `harness.finalize` would fabricate a clinical note from a truncated transcript and queue it for a clinician. Resolved when the loop config is PINNED at workflow start and frozen for the whole consultation, so a change applies to consultations that start after it — unlike the `harness.loop.enabled` kill-switch, which is re-read on every signal.',
    default: HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT,
  },
];
