/**
 * The doctor's own DNA writing-style opt-out — a per-user preference (TASK-882).
 *
 * It used to be the DOCTOR-scope row of the retired `PipelinePolicy` cascade. A clinician's
 * preference over their own writing style is theirs (P-4), so it lives in the per-user key/value
 * store (`UserSettings`), written by `PUT dna-writing-styles/settings` and read by
 * `ConfigResolver.resolveDoctorDnaPreference`. The dotted name `dna.styleEnabled` is the
 * `(namespace, key)` pair below.
 *
 * Three states, as before: `true` = explicit opt-in, `false` = explicit opt-out, no row = no
 * opinion, which every reader treats as an implicit opt-in.
 */
export const DNA_STYLE_PREFERENCE = Object.freeze({
  namespace: 'dna',
  key: 'styleEnabled',
  /** The row's display name — `namespace:key`, the convention `UserSettingsService` uses. */
  name: 'dna:styleEnabled',
});

/** The stored string back to the three-state toggle; anything else is no opinion. */
export function parseDnaStylePreference(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}
