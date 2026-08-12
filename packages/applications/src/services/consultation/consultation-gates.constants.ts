// Consultation-pipeline enforcement gates — `global-kv` kill-switches (TASK-679).
//
// The two `@OnEvent(ContextAdded)` consumers that hang off the consultation
// pipeline — `LoopContextSignalService` and `OcrEnrichmentProcessor` — each
// carry an on/off gate. Both were plain `process.env`-backed flags read ONCE in
// their constructor, which violates the two load-bearing statements of
// `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers:
//
//   • the BOOTSTRAP FLOOR — a variable stays in `env` only if it is required to
//     REACH THE DATABASE or AUTHENTICATE TO VAULT. Neither gate is;
//   • §9.2 L1 — env vars are IMMUTABLE for the process lifetime, so anything
//     that must change without a restart is not an env var. A kill-switch that
//     needs a redeploy is a build flag, not a kill-switch (§9.3 M9).
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
// config path in any HOPE environment (see the TASK-679 audit table).

/** `GlobalSetting` key for the consultation-loop signal gate. */
export const HARNESS_LOOP_ENABLED_KEY = 'harness.loop.enabled';

/** `GlobalSetting` key for the server-side OCR-enrichment gate. */
export const CONSULTATION_OCR_ENABLED_KEY = 'consultation.ocr.enabled';

/**
 * Code defaults — the last fallback in the cascade, and the single source of
 * truth shared by the descriptors and their consumers. Both OFF: a kill-switch
 * MUST default OFF (fail-safe rollout, §9.3 M9).
 */
export const CONSULTATION_GATE_DEFAULTS = {
  [HARNESS_LOOP_ENABLED_KEY]: false,
  [CONSULTATION_OCR_ENABLED_KEY]: false,
} as const;
