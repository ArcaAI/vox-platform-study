/**
 * TASK-972 Lane 2 (OD-4) — the clinician's own training-capture opt-out.
 *
 * The gate-edit learning loop mines a PHI-redacted `(AI draft, signed note)` pair from every
 * sign-off. Until this ticket that pipeline had effectively no live writer, so its total absence
 * of a consent check (§2.4: zero `ConsentGrant` references anywhere in it) was latent. Routing
 * the clinician's submit into HOPE makes it the platform's highest-volume source of clinical
 * text derived from a person's own writing, which is exactly the shape the DNA writing-style
 * feature already gates behind a three-state per-doctor toggle.
 *
 * So this is DNA's `dna:styleEnabled` again, for a different feature and under its own name:
 * a per-user key/value row (`UserSettings`, no migration), read by
 * `ConfigResolver.resolveEffectiveTrainingCaptureEnabled` alongside the tenant's settings-registry
 * gate. The dotted name `trainingCapture.enabled` is the `(namespace, key)` pair below.
 *
 * Three states, and the third is load-bearing: `true` = explicit opt-in, `false` = explicit
 * opt-out, **no row = no opinion**, which every reader treats as an implicit opt-in. A
 * clinician who has never been asked must not be silently excluded from a corpus the platform
 * already builds; a clinician who has said no must never be included.
 *
 * Full `ConsentGrant` binding (`ConsentPurpose.STYLE_LEARNING` / `QUALITY_REVIEW`) is FU-4.
 */
export const TRAINING_CAPTURE_PREFERENCE = Object.freeze({
  namespace: 'trainingCapture',
  key: 'enabled',
  /** The row's display name — `namespace:key`, the convention `UserSettingsService` uses. */
  name: 'trainingCapture:enabled',
});

/** The stored string back to the three-state toggle; anything else is no opinion. */
export function parseTrainingCapturePreference(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}
