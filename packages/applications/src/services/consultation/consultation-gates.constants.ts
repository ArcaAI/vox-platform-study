// Consultation-pipeline enforcement gates — `global-kv` kill-switches.
//
// The two `@OnEvent(ContextAdded)` consumers that hang off the consultation
// pipeline — `LoopContextSignalService` and `OcrEnrichmentProcessor` — each
// carry an on/off gate. Both were plain `process.env`-backed flags read ONCE in
// their constructor, which violates the two load-bearing statements of
// `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers:
//
//   • the BOOTSTRAP FLOOR — a variable stays in `env` only if it is required to
//     REACH THE DATABASE or AUTHENTICATE TO VAULT. Neither gate is;
// • env vars are IMMUTABLE for the process lifetime, so anything
//     that must change without a restart is not an env var. A kill-switch that
// needs a redeploy is a build flag, not a kill-switch.
//
// Both keys therefore live in `GlobalSetting` (`global-kv`), are resolved at
// CALL time through `TenantSettingsService.resolvePlatform`, and propagate on
// the existing `app-settings:invalidate` channel — no second flag store, no
// second invalidation contract (the settled `redis-flag` decision, recorded in
// `feature-flags.descriptors.ts`).
//
// KILL-SWITCH POLARITY. Both are ENFORCEMENT/engine gates that ship OFF, not
// PROTECTIONS that ship ON, so both are `killSwitch: true` and both default
// `false` — `SettingsRegistry.killSwitches()` refuses assembly otherwise, and
// `EffectiveSettingsModule.onModuleInit` refuses BOOT.
//
// NO ENV BOOTSTRAP FALLBACK — deliberately, and unlike `platform-knobs.descriptors.ts`.
// That file keeps `<KEY>` as a documented first-boot fallback because its knobs
// have non-trivial defaults a fresh database would otherwise lose. These two do
// not: absence resolves to OFF, which is both the safe answer and the answer the
// descriptor already declares, so an env read could only ever re-introduce the
// immutability defect it exists to remove. There is also nothing to preserve —
// `OCR_ENABLED` and `HARNESS_LOOP_ENABLED` appear in NEITHER `.env.sample` NOR
// `turbo.json#globalEnv`, so neither was ever settable through the supported
// config path in any HOPE environment (see the audit table).

/**
 * TASK-705 — the consultation loop's PLATFORM EMERGENCY STOP.
 *
 * REPLACES `harness.loop.enabled`, and the polarity flip is the whole point.
 *
 * WHAT WENT WRONG WITH THE OLD KEY. It tried to be two things at once —
 * commercial eligibility AND an operational stop — and the two want opposite
 * fail-safe defaults, which is exactly the defect it shipped with:
 *
 *   descriptor default   `false`   (the kill-switch invariant: never ship armed)
 *   seeded row value     `'true'`  (the product requirement: on for day 1)
 *
 * Those two disagree, and nothing reconciles them. Worse, they disagree
 * SILENTLY in the direction that matters: `packages/database/migrate.sh`
 * defaults `RUN_SEED=none`, and `hope-v2-dev` explicitly pins it to `"none"`
 * (owner decision 2026-08-09), so the row that carries the real intent is never
 * re-asserted. An environment that never seeds — or one seeded before the row
 * existed — resolves the code default and runs no loop, with no signal that the
 * intended answer was the opposite.
 *
 * THE FIX IS TO SEPARATE THE TWO CONCERNS AND GIVE EACH ITS OWN DEFAULT.
 * Eligibility is now the tenant's SUBSCRIPTION ENTITLEMENT
 * (`ResolvedFeatures.agenticLoop`, resolved tenant-plan → platform matrix from
 * the database — owner decision 2026-08-17 §2 row 705). What is left here is a
 * pure operational device, and with NEGATIVE polarity its fail-safe default and
 * the day-1 product requirement finally agree:
 *
 *   default `false`  =  no emergency in progress  =  entitled tenants run
 *   set     `true`   =  stop every loop, platform-wide, no redeploy
 *
 * So there is nothing left to seed, and nothing left to disagree about. The
 * `killSwitch: true` classification is retained and honest: the switch still
 * ships DISARMED, which is what `SettingsRegistry.killSwitches()` enforces.
 *
 * COMPOSITION RULE (pinned by `loop/__tests__/loop-entitlement-gate.test.ts`):
 *
 *     signals(tenant) ⇔ entitlement(tenant).agenticLoop AND NOT emergencyStop
 *
 * The stop can only ever SUBTRACT. Engaging it stops an entitled tenant;
 * disengaging it never grants an unentitled one.
 */
export const HARNESS_LOOP_EMERGENCY_STOP_KEY = 'harness.loop.emergencyStop';

/** `GlobalSetting` key for the server-side OCR-enrichment gate. */
export const CONSULTATION_OCR_ENABLED_KEY = 'consultation.ocr.enabled';

/**
 * TASK-711 (Task 9) — the ONE breaking precondition in the session
 * state-machine rollout: `PRIMED → RECORDING` is enforced only when this
 * gate is ON. Default OFF so no existing SDK/admin-console caller (none of
 * which call `POST :id/prime` yet) is broken on deploy; OFF logs the
 * would-be violation and proceeds, ON enforces (409 on `recording/start`
 * without a prior `prime`). Deleted once TASK-712 makes `prime` the
 * consent checkpoint end-to-end (state-machine.md §2 row 2).
 */
export const CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY = 'consultation.state.requirePrimedBeforeRecording';

/**
 * TASK-711 (state-machine.md §1a) — general session-idleness timeout, in
 * minutes, consulted by the (not-yet-built) scheduled sweep that transitions
 * stale sessions to `CLOSED_INCOMPLETE`. NOT a kill-switch (no on/off
 * semantics) — a tuning knob, `failMode: open-to-default` so an absent value
 * never stalls the sweep. Documented default 1440 (24h), provisional.
 */
export const CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY = 'consultation.state.sessionTimeoutMinutes';

/**
 * Code defaults — the last fallback in the cascade, and the single source of
 * truth shared by the descriptors and their consumers. Kill-switches default
 * OFF (fail-safe default; a kill-switch must not require a redeploy).
 */
export const CONSULTATION_GATE_DEFAULTS = {
  // `false` = no emergency in progress. Disarmed, and therefore not a veto.
  [HARNESS_LOOP_EMERGENCY_STOP_KEY]: false,
  [CONSULTATION_OCR_ENABLED_KEY]: false,
  [CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY]: false,
  [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 1440,
} as const;
