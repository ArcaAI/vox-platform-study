// TASK-891 B1 — realtime consultation-scribe runtime budgets.
//
// ## Why this key exists
//
// `LIVE_DOC_TEXT_TIMEOUT_MS` was a raw env read in the live-documentation
// constructor with a hard-coded `?? 20000` fallback and no row anywhere. Measured on
// `hope-v2-dev` (2026-09-07): ONE realtime SOAP generation takes **14.06 s on an idle
// cluster** with a 136-token transcript, and 20–52 s when Whisper is competing for the
// same time-sliced GPUs. The budget was therefore below the p50 of the thing it was
// budgeting, and EVERY realtime summary call timed out — the gateway logged
// `timeout of 20000ms exceeded` on every flush of the traced session.
//
// A budget that must move when a model, a GPU or a load profile changes is not a
// deploy-time constant (`09-infrastructure-devops.md` §Configuration Tiers, corollary
// L1: an env var is immutable for the process lifetime). It is a tuning knob, so it is
// `global-kv` / `open-to-default`, resolved on every flush like the `agentic.context.*`
// siblings — a super admin's write governs the next flush with no redeploy.
//
// The env var stays supported as the OPERATIONAL lane and deliberately LOSES to a
// stored value, exactly as `agentic-context.descriptors.ts` documents for its own keys:
// the registry is the control plane.
//
// ## Why the default is 60000 and not "a bit more than 20000"
//
// The observed distribution is 14 s idle → 52 s loaded. A budget must sit above the
// tail it is protecting against, or it converts a slow flush into no flush at all —
// which is the failure this ticket exists to fix. The single-flight gate (B3) is what
// bounds the cost of a generous budget: at most ONE generation per session is ever in
// flight, so a slow model degrades cadence rather than piling up concurrent calls.

import { SettingDescriptor } from '../registry.types';

/** The governed realtime TEXT budget (ms). */
export const CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY = 'consultation.realtime.textTimeoutMs';

/**
 * Code defaults for the `consultation.realtime.*` runtime budgets — the single source
 * of truth shared by the descriptors below and the live-documentation consumer.
 */
export const CONSULTATION_REALTIME_DEFAULTS = {
  [CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY]: 60000,
} as const;

export const CONSULTATION_REALTIME_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned, like every other `agentic`/live-loop knob: this is a budget for
    // the platform's own gateway→TEXT hop, not a clinical preference a tenant holds an
    // opinion about. A per-tenant row would also multiply the resolution cardinality of
    // a value read on every flush.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // A tuning knob: an absent row degrades to the code default, never to an outage.
    // (`failMode` governs an ABSENT VALUE only — a settings-backend error still
    // propagates and is never disguised as "the default".)
    failMode: 'open-to-default',
    category: 'Agentic Context',
    label: 'Realtime TEXT generation timeout (ms)',
    description:
      'Per-call budget for the gateway→TEXT hop on the REALTIME consultation lane (the running note, the grammar/corrections pass and the important-findings pass). Replaces the hard-coded 20000 ms behind `LIVE_DOC_TEXT_TIMEOUT_MS`, which sat BELOW the measured p50 of a realtime SOAP generation (14 s idle, 20–52 s under GPU contention) and therefore timed out every flush. The env var is still read as an operational override and deliberately loses to a stored value. Raising it is bounded by the single-flight flush gate: at most one generation per session is ever in flight.',
    default: CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY],
  },
];
