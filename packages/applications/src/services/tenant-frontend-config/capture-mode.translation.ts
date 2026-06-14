import { CaptureMode } from '@arcaai/domains';

/**
 * TASK-356 Phase 4 (A5) — CaptureMode translation layer.
 *
 * The single, table-driven mapping from the tenant-scoped `CaptureMode` enum
 * onto the two capture surfaces that already exist:
 *   - BACKEND (per-pipeline YAML): `preprocessing.dual_capture.capture_raw` +
 *     `postprocessing.dual_capture.capture_processed`.
 *   - LOCAL (frontend): the `captureRawAudio` boolean.
 *
 * `null`/`undefined` (no tenant override) maps to `null` everywhere so callers
 * keep today's per-surface behaviour (back-compat, R-6): the local path falls
 * back to the legacy `captureRawAudio` column; the backend booleans stay the
 * per-pipeline source of truth.
 */
export interface DualCaptureFlags {
  captureRaw: boolean;
  captureProcessed: boolean;
}

/**
 * Map a `CaptureMode` onto the two backend `dual_capture` booleans. Returns
 * `null` when the mode is unset (no tenant override).
 */
export function captureModeToDualCapture(mode: CaptureMode | null | undefined): DualCaptureFlags | null {
  switch (mode) {
    case CaptureMode.RAW_AND_PROCESSED:
      return { captureRaw: true, captureProcessed: true };
    case CaptureMode.RAW_ONLY:
      return { captureRaw: true, captureProcessed: false };
    case CaptureMode.PROCESSED_ONLY:
      return { captureRaw: false, captureProcessed: true };
    case CaptureMode.NONE:
      return { captureRaw: false, captureProcessed: false };
    default:
      return null;
  }
}

/**
 * Map a `CaptureMode` onto the local `captureRawAudio` flag (the `captureRaw`
 * leg of {@link captureModeToDualCapture}). Returns `null` when the mode is
 * unset so the caller falls back to the legacy `captureRawAudio` column.
 */
export function captureModeToLocalRawCapture(mode: CaptureMode | null | undefined): boolean | null {
  const flags = captureModeToDualCapture(mode);
  return flags ? flags.captureRaw : null;
}
