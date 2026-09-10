// Settings registry barrel.
export * from './registry.types';
export * from './scope-cascade';
export * from './settings-registry';
export * from './effective-settings.service';
export * from './effective-settings.module';
export * from './registry';
export * from './descriptors/entitlements.descriptors';
export * from './descriptors/agentic-context.descriptors';
// TASK-891 B1 — the realtime TEXT budget; the live-documentation consumer reads
// `CONSULTATION_REALTIME_DEFAULTS` as its code default.
export * from './descriptors/consultation-realtime.descriptors';
export * from './descriptors/agentic-eval.descriptors';
export * from './descriptors/agentic-fewshot.descriptors';
// Batch upload ceilings — the gateway reads `BATCH_TRANSCRIPTION_DEFAULTS` as
// its fallback when the settings module is not wired.
export * from './descriptors/batch-transcription.descriptors';
export * from './descriptors/platform-ops.descriptors';
// `service-runtime.descriptors` is exported from the package root via a
// dedicated path (its `SERVICE_RUNTIME_DEFAULTS` is shared with the
// effective-config service) and is intentionally not re-exported here.
export * from './descriptors/platform-secrets.descriptors';
export * from './descriptors/bootstrap-env.descriptors';
export * from './descriptors/platform-knobs.descriptors';
// TASK-932 — the feature-availability catalog: the matrix screen and its
// endpoints select on `FEATURE_AVAILABILITY_CATEGORY`, and Lane N's console
// gates read the keys.
export * from './descriptors/feature-availability.descriptors';
// A NAMED re-export, not a `export *`: `service-runtime.descriptors` stays off
// the barrel (its `SERVICE_RUNTIME_DEFAULTS` travels a dedicated path), but the
// gateway's boot-time env schema is built from descriptors and this is the one
// env-tier key left in that file -- it used to reach `env.schema.ts` inside
// `FEATURE_FLAG_SETTINGS`, which TASK-932 deleted.
export { HARNESS_CLAIM_CHECK_ENABLED } from './descriptors/service-runtime.descriptors';
// TASK-950 — the three `identity.autoProvision.*` keys. `ContextUserIdentityService`
// resolves them by KEY through `EffectiveSettingsService`, and the seed writes the SYSTEM
// role row by the same constant, so both sides name one exported symbol.
export * from './descriptors/user-identity.descriptors';
export * from './settings-registry-write.service';
// TASK-932 R-6/D-6 -- the derived lock (bootstrap / credential / data-plane are
// un-editable for everyone) and the tenant-visibility predicate behind R-1/D-5.
export * from './setting-lock';
export * from './catalog-visibility';
export * from './feature-availability.service';
export * from './tenant-clamp';
export * from './tenant-settings.service';
