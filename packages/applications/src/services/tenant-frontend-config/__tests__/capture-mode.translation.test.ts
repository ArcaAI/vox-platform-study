/**
 * CaptureMode translation layer.
 *
 * Single, table-driven mapping from the tenant-scoped `CaptureMode` enum onto:
 *   - the two backend pipeline-YAML `dual_capture` booleans
 *     (`preprocessing.dual_capture.capture_raw` /
 *      `postprocessing.dual_capture.capture_processed`), and
 *   - the local `captureRawAudio` flag.
 *
 * `null` (no tenant override) maps to `null` everywhere so callers fall back to
 * the legacy per-surface behaviour (back-compat, R-6).
 */
import { describe, it, expect } from 'vitest';
import { CaptureMode } from '@arcaai/domains';
import { captureModeToDualCapture, captureModeToLocalRawCapture } from '../capture-mode.translation';

describe('captureModeToDualCapture', () => {
  it.each([
    { mode: CaptureMode.RAW_AND_PROCESSED, captureRaw: true, captureProcessed: true },
    { mode: CaptureMode.RAW_ONLY, captureRaw: true, captureProcessed: false },
    { mode: CaptureMode.PROCESSED_ONLY, captureRaw: false, captureProcessed: true },
    { mode: CaptureMode.NONE, captureRaw: false, captureProcessed: false },
  ])('maps $mode → { captureRaw: $captureRaw, captureProcessed: $captureProcessed }', ({ mode, captureRaw, captureProcessed }) => {
    expect(captureModeToDualCapture(mode)).toEqual({ captureRaw, captureProcessed });
  });

  it('returns null for a null mode (no tenant override)', () => {
    expect(captureModeToDualCapture(null)).toBeNull();
  });

  it('returns null for an undefined mode (no tenant override)', () => {
    expect(captureModeToDualCapture(undefined)).toBeNull();
  });
});

describe('captureModeToLocalRawCapture', () => {
  it.each([
    { mode: CaptureMode.RAW_AND_PROCESSED, expected: true },
    { mode: CaptureMode.RAW_ONLY, expected: true },
    { mode: CaptureMode.PROCESSED_ONLY, expected: false },
    { mode: CaptureMode.NONE, expected: false },
  ])('maps $mode → local raw capture $expected', ({ mode, expected }) => {
    expect(captureModeToLocalRawCapture(mode)).toBe(expected);
  });

  it('returns null for a null/undefined mode (legacy captureRawAudio fallback)', () => {
    expect(captureModeToLocalRawCapture(null)).toBeNull();
    expect(captureModeToLocalRawCapture(undefined)).toBeNull();
  });
});
