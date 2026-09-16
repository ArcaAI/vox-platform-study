// TASK-982 §3.4.5 — the warm-start pre-summary's bounded retry.
//
// `LivePreSummaryAdapter.run` (the WARM START — TASK-932 D-9, run once at recording start, never
// on the flush lane `consultation-realtime.descriptors.ts` governs) called `generatePreSummary`
// exactly once and degraded on ANY failure, including the TEXT service's own transient hiccups
// (a `text_unavailable`-class 5xx/ECONNRESET). A tuning knob for how many extra attempts to make
// before degrading is a `global-kv` / `open-to-default` value, the same posture the realtime
// flush's own groundedness retry budget already has — never a literal in the adapter.

import { SettingDescriptor } from '../registry.types';

/** Additional attempts the warm-start pre-summary makes after a transient (`text_unavailable`) failure. */
export const CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_KEY = 'consultation.preSummary.retry.attempts';

export const CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT = 1;

export const CONSULTATION_PRE_SUMMARY_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned, same reasoning as `consultation.realtime.*`: a budget for the platform's
    // own gateway→TEXT hop, not a clinical preference a tenant holds an opinion about.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // A tuning knob: an absent row degrades to the code default (1), never to an outage.
    failMode: 'open-to-default',
    category: 'Agentic Context',
    label: 'Pre-summary retry attempts',
    description: 'Additional attempts the warm-start pre-summary makes after a transient text-service failure.',
    default: CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT,
    validate: (value: unknown) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
        return 'Pre-summary retry attempts must be an integer between 0 and 3.';
      }
    },
  },
];
