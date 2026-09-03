/**
 * `GlobalSetting` rows under the `feature-flags` namespace
 * (`packages/database/src/prisma/db_main/seed/11-global-setting.ts`) that
 * have NO runtime consumer today (verified 2026-09-01, F-23 / item
 * 7): no gateway module reads them, and no `@arcaai/vox` SDK hook branches
 * on the `TenantAudioConfig.features` values they would produce — the SDK's
 * `TENANT_CONFIG_KEYS.ENABLE_REAL_TIME_TRANSCRIPTION` constant
 * (`'enable-real-time-transcription'`) does not even match this seeded key
 * (`'enable-transcription'`), so the computed flag is doubly disconnected.
 * Toggling one of these in the console changes nothing at runtime.
 *
 * Deliberately EXCLUDED (these ARE enforced — do not add them here):
 *  - `enable-consultation-sharing` — read by
 *    `ConsultationController.isSharingEnabled()`
 *    (`apps/api/src/modules/consultation/consultation.controller.ts`) to gate
 *    cross-doctor shared-patient reads.
 *  - `enable-local-raw-capture` — a synthetic, non-persisted row
 *    (`MyTenantController.buildLocalRawCaptureRow`) computed from a real
 *    platform-capability-AND-tenant-toggle read; it never reaches this grid
 *    as a stored row in the first place.
 */
const ADVISORY_FEATURE_FLAG_KEYS = new Set<string>([
  'enable-transcription',
  'enable-ner-extraction',
  'enable-dna-style',
  'enable-cross-chain-summary',
  'enable-code-switching',
]);

export const ADVISORY_FEATURE_FLAG_HINT = 'Advisory only — no runtime path reads this flag today';

export function isAdvisoryFeatureFlag(setting: { namespace?: string; key: string }): boolean {
  return setting.namespace === 'feature-flags' && ADVISORY_FEATURE_FLAG_KEYS.has(setting.key);
}
