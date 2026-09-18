/**
 * @arcaai/vox — browser capture constraints (TASK-985 M-33 / OD-L)
 *
 * The three browser DSP switches — AEC, noise suppression, AGC — were declared
 * in `AudioConfigSchema`, permission-tagged in `CONFIG_PERMISSIONS` as
 * `permission: 'user'`, resolved through the tenant → user cascade into
 * `AppConfig.audio`… and then read by NOBODY. A repo-wide search for a reader
 * of `config.audio.echoCancellation` / `.noiseSuppression` / `.autoGainControl`
 * returned zero hits. The only thing that ever reached `getUserMedia` was the
 * ephemeral per-call `AudioStartOptions.audioProcessing` override, which has no
 * governance at all: two disconnected mechanisms, one of them dead.
 *
 * This module is the missing hop. It is deliberately a PURE function of the
 * already-resolved config — it introduces no new config tier, no env var and no
 * new cascade; it wires a value the platform already resolves through to the
 * one place capture actually happens.
 *
 * **It does not change what ships.** `AudioConfigSchema` defaults all three to
 * `true` and every major browser defaults all three to ON, so the resolved
 * constraint set is what capture already used. Whether the governed DEFAULT
 * should instead ship with NS/AGC OFF (external practice for server-side ASR
 * is "AGC off, never disable AEC") is owner decision OD-L, and it is unanswered
 * — the A/B that would answer it has not run. This makes the knob REAL so that
 * decision has something to act on; it does not pre-empt it.
 */

import type { AppConfig } from './ConfigSchema';
import type { AudioProcessingConstraints } from '../types/audio';

/** The three switches, in one place, so a reader cannot drift from a writer. */
const CAPTURE_CONSTRAINT_KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

export type CaptureConstraintKey = (typeof CAPTURE_CONSTRAINT_KEYS)[number];

/**
 * Resolve the browser capture constraints for one session.
 *
 * Precedence is the SAME one the SDK documents everywhere else — per-call
 * runtime option beats the resolved cascade — so a caller that passes
 * `audio.start({ audioProcessing })` keeps winning exactly as before.
 *
 * Only STATED keys are returned. That matters at the call site: an empty object
 * means the caller can keep requesting `{ audio: true }` rather than
 * `{ audio: {} }`, which is a materially different `getUserMedia` request.
 */
export function resolveCaptureConstraints(
  resolvedConfig: AppConfig | null | undefined,
  perCall: AudioProcessingConstraints | undefined,
): AudioProcessingConstraints {
  const governed = resolvedConfig?.audio as Partial<Record<CaptureConstraintKey, unknown>> | undefined;
  const merged: AudioProcessingConstraints = {};

  for (const key of CAPTURE_CONSTRAINT_KEYS) {
    const governedValue = governed?.[key];
    if (typeof governedValue === 'boolean') merged[key] = governedValue;
    const perCallValue = perCall?.[key];
    if (typeof perCallValue === 'boolean') merged[key] = perCallValue;
  }

  return merged;
}

/**
 * Re-assert the resolved constraints on live tracks with `applyConstraints`.
 *
 * A `getUserMedia` constraint is a REQUEST, not a guarantee, and it is made
 * exactly once — at acquisition. `applyConstraints` is the authoritative,
 * repeatable statement, which is what a microphone that JOINS mid-session
 * (`addSource`) needs: without it, a late mic arrives under whatever the
 * browser felt like and the mix ends up half-processed.
 *
 * Never throws. A device or browser that refuses a constraint is a diagnostic,
 * not a reason to fail a consultation that is already capturing.
 */
export async function applyCaptureConstraints(
  tracks: MediaStreamTrack[],
  constraints: AudioProcessingConstraints,
  onFailure?: (error: unknown, track: MediaStreamTrack) => void,
): Promise<void> {
  if (Object.keys(constraints).length === 0) return;
  await Promise.all(
    tracks.map(async (track) => {
      try {
        await track.applyConstraints?.({ ...constraints });
      } catch (error) {
        onFailure?.(error, track);
      }
    }),
  );
}
