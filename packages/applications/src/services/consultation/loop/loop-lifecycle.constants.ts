// Consultation-loop LIFECYCLE bound — a `global-kv` tuning knob.
//
// `ConsultationLoopWorkflow` waits for `contextAdded` / `consultation-ending` /
// `loop-cancel`. That wait used to be UNBOUNDED, so a consultation that never
// sent an ending left the workflow running forever — and `signalLoopCancel` has
// no production caller (concluded that wiring it to `close` is unsafe
// because a `_cancelled`-before-`_ending` race would skip finalize and lose the
// note), so there was no reliable second exit.
//
// WHY THIS IS NOT AN ENV VAR. Both load-bearing statements of
// `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers apply:
//
//   • the BOOTSTRAP FLOOR — a variable stays in `env` only if it is required to
//     REACH THE DATABASE or AUTHENTICATE TO VAULT. This is neither;
// • env vars are IMMUTABLE for the process lifetime. An operator
//     discovering that a department's consultations legitimately go quiet for
//     longer than the bound must be able to raise it without a redeploy.
//
// It is NOT a kill-switch (it does not gate enforcement, and it has a non-trivial
// default that "off" cannot express), so it is not `killSwitch: true` and it does
// not join `CONSULTATION_GATE_SETTINGS`.
//
// PINNED, NOT LIVE. Unlike `harness.loop.emergencyStop` — which is resolved on EVERY
// signal precisely so a misbehaving loop can be stopped mid-flight — this value
// is read ONCE, when `LoopConfigService` resolves the config the workflow pins
// at start, and is then frozen for the whole consultation. It has
// to be: the workflow body may not re-read configuration mid-run without
// breaking replay determinism, and a bound that changed underneath a running
// loop would be exactly the non-determinism the pinned-config design exists to
// prevent. A change therefore applies to consultations that START after it.

/** `GlobalSetting` key for the consultation-loop idle lifecycle bound. */
export const HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY = 'harness.loop.idleTimeoutSeconds';

/**
 * Code default — 4 hours.
 *
 * The bound is on IDLENESS, not on total duration: every `contextAdded` restarts
 * it, and during a live consultation the STT/LiveDoc lane feeds context
 * continuously. Four hours is therefore comfortably longer than any plausible
 * in-session silence (a full clinic session, with examinations and
 * interruptions), and enormously shorter than "forever". It is a knob rather
 * than a constant because how long a department's consultations may legitimately
 * go quiet is a property of the department, not of the orchestrator.
 */
export const HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT = 14400;
