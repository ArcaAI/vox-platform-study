/**
 * Canonical speaker-id → display-label mapping.
 *
 * This is the SINGLE place the streaming pipeline turns a raw diarizer
 * `speaker_id` into the human-readable `speakerLabel` that rides the wire
 * ({@link StreamingTranscriptMessage.speakerLabel}). The streaming bridge calls
 * it ONCE, so every downstream consumer (the @arcaai/vox SDK client, the admin
 * console live-transcription hook) reads the derived label off the wire instead
 * of re-deriving its own — closing the fragmented-derivation gap that used to
 * exist across consumers.
 *
 * Label semantics:
 * - the streaming diarizer emits only ANONYMOUS ids — `"Speaker 0"`,
 *   `"Speaker 1"`, … (`speaker_tracker.py`) — plus the `"unknown"` sentinel
 *   stamped when diarization ran but produced no confident match
 *   (`inference.py`).
 * - anonymous ids are already human-readable and pass through verbatim; role
 *   labels ("Clinician"/"Patient") and preseeded clinician NAMES (PHI-gated)
 *   are layered on later — this seam is where they will be injected.
 *
 * PHI posture: this mapping NEVER fabricates or surfaces a raw clinician/patient
 * name. It only reshapes the anonymous ids / sentinel the streaming path emits
 * today; name preseed is out of scope and off here.
 */

/** stt-v2's no-confident-match sentinel, stamped on the wire as `speaker_id`. */
const UNKNOWN_SPEAKER_SENTINEL = 'unknown';

/** Neutral, clinician-facing placeholder for the `"unknown"` sentinel. */
const UNKNOWN_SPEAKER_LABEL = 'Unknown speaker';

/**
 * Derive the canonical `speakerLabel` for a diarizer `speaker_id`.
 *
 * @param speakerId - the raw diarizer id from the wire (`speaker_id`), or
 *   `undefined`/`null`/empty when the segment carries no speaker attribution
 *   (partials, or diarization off).
 * @returns the display label, or `undefined` when there is no speaker to label.
 */
export function deriveSpeakerLabel(speakerId?: string | null): string | undefined {
  if (typeof speakerId !== 'string') return undefined;
  const id = speakerId.trim();
  if (!id) return undefined;
  if (id.toLowerCase() === UNKNOWN_SPEAKER_SENTINEL) return UNKNOWN_SPEAKER_LABEL;
  return id;
}
